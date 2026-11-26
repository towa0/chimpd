import http from 'node:http';
import { realNow, realSetTimeout } from '../core/clock.js';
import type { FailureEvidence } from '../core/types.js';
import type { CallMetadata } from '../fault-injector/call-capture.js';
import { installInjection, type InjectedEvent } from '../fault-injector/inject.js';
import type { ResponseWatch } from '../fault-injector/response-use.js';
import { INJECTORS } from '../fault-injector/injectors.js';
import { MALFORMED_BODY, watchJsonParse } from '../fault-injector/malformed-json.js';
import { SERVER_ERROR_BODY } from '../fault-injector/server-error.js';
import { targetsSite } from './call-site.js';
import { traceFailure } from './failure.js';
import type { FaultMode, InjectedCall } from './protocol.js';
import type { BodyEnding, BodyReport, Session, TestBody } from './runtime.js';

interface InjectedRecord {
  readonly metadata: CallMetadata | null;
  readonly call: Omit<InjectedCall, 'response'>;
}

interface RunningBody {
  readonly calls: CallMetadata[];
  targetedCalls: number;
  readonly injected: InjectedRecord[];
  readonly responses: Map<CallMetadata, ResponseWatch>;
  jsonParsed: boolean;
  escaped: FailureEvidence | null;
}

const INJECT_GRACE_MS = 500;
const INJECT_POLL_MS = 5;

function recordOf(event: InjectedEvent, metadata: CallMetadata | null): Omit<InjectedCall, 'response'> {
  const { initiator } = event;
  return {
    method: event.request.method,
    url: event.request.url,
    path: metadata?.path ?? 'unknown',
    errorReachedCaller: initiator instanceof http.ClientRequest ? initiator.listenerCount('error') > 0 : true,
  };
}

/** Hears of a fault error that escaped unhandled after the body it belongs to had ended. */
type LateEscape = (owner: TestBody, failure: FailureEvidence) => void;

// What JSON.parse throws on these bodies is the fault's own error, as much as a refusal is.
const PARSED_BODIES: Readonly<Partial<Record<FaultMode['faultKind'], string>>> = {
  'malformed-json': MALFORMED_BODY,
  'http-500': SERVER_ERROR_BODY,
};

/** Answers every call the selected test bodies make to the site with the mode's fault, and nothing else. */
export function startInjection(mode: FaultMode, current: () => TestBody | undefined, onLateEscape: LateEscape): Session {
  if (mode.faultKind === 'blackhole') throw new Error('the black hole holds calls; it is not injected');
  const inject = INJECTORS[mode.faultKind];
  if (inject === undefined) throw new Error(`bruise cannot inject ${mode.faultKind} yet`);
  const selected = new Set(mode.testIds);
  const running = new Map<TestBody, RunningBody>();
  const owners = new WeakMap<CallMetadata, TestBody>();
  // Every error the fault raised, by the body it was raised in: the refusal itself, or what JSON.parse threw on the faulted body.
  const faultErrors = new WeakMap<object, TestBody>();
  const isFaultError = (value: object): boolean => faultErrors.has(value);

  function recordFaultError(error: unknown, owner: TestBody | undefined): void {
    if (owner !== undefined && typeof error === 'object' && error !== null) faultErrors.set(error, owner);
  }

  function onUnhandled(reason: unknown): void {
    const { evidence, faultError } = traceFailure(reason, 'unhandled', mode.targetRoot, isFaultError);
    const owner = faultError === null ? undefined : faultErrors.get(faultError);
    if (owner === undefined) return;
    const active = running.get(owner);
    if (active === undefined) onLateEscape(owner, evidence);
    else active.escaped ??= evidence;
  }

  const injection = installInjection(['fetch', 'client-request'], {
    onCall(metadata) {
      const owner = current();
      const active = owner === undefined ? undefined : running.get(owner);
      if (owner === undefined || active === undefined) return;
      if (!targetsSite(metadata.stack, mode)) return;
      active.targetedCalls += 1;
      active.calls.push(metadata);
      owners.set(metadata, owner);
    },
    shouldInject: (metadata) => metadata !== null && owners.has(metadata),
    inject,
    onInjected(event, metadata, raised) {
      const owner = metadata === null ? undefined : owners.get(metadata);
      const active = owner === undefined ? undefined : running.get(owner);
      active?.injected.push({ metadata, call: recordOf(event, metadata) });
      if (active !== undefined) recordFaultError(raised, owner);
    },
    onResponse(metadata, watch) {
      const owner = owners.get(metadata);
      const active = owner === undefined ? undefined : running.get(owner);
      active?.responses.set(metadata, watch);
    },
  });

  const parsedBody = PARSED_BODIES[mode.faultKind];
  const activeOwner = (): TestBody | undefined => {
    const owner = current();
    return owner !== undefined && running.has(owner) ? owner : undefined;
  };
  const restoreParse =
    parsedBody === undefined
      ? () => undefined
      : watchJsonParse(parsedBody, {
          onParse() {
            const owner = activeOwner();
            const active = owner === undefined ? undefined : running.get(owner);
            if (active !== undefined) active.jsonParsed = true;
          },
          onError: (error) => recordFaultError(error, activeOwner()),
        });
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtExceptionMonitor', onUnhandled);

  return {
    includes: (task) => selected.has(task.id),
    begin(body) {
      running.set(body, { calls: [], targetedCalls: 0, injected: [], responses: new Map(), jsonParsed: false, escaped: null });
    },
    async end(body, ending: BodyEnding): Promise<BodyReport> {
      const active = running.get(body);
      if (active === undefined) return { targetedCalls: 0, observations: [], injections: [] };
      // A body that does not wait for its request can end before the request reaches the interceptor.
      const giveUpAt = realNow() + INJECT_GRACE_MS;
      while (active.injected.length < active.targetedCalls && realNow() < giveUpAt) {
        await new Promise((resolve) => realSetTimeout(resolve, INJECT_POLL_MS));
      }
      running.delete(body);
      for (const metadata of active.calls) owners.delete(metadata);
      const injections = active.injected.map(({ metadata, call }) => ({
        ...call,
        response: (metadata === null ? undefined : active.responses.get(metadata))?.use() ?? null,
      }));
      const parse = mode.faultKind === 'malformed-json' ? { jsonParsed: active.jsonParsed } : {};
      const thrown = ending.threw ? traceFailure(ending.error, 'test', mode.targetRoot, isFaultError).evidence : null;
      // A fault error that escaped unhandled outweighs whatever the test then failed on.
      const failure = active.escaped ?? thrown;
      return { targetedCalls: active.targetedCalls, observations: [], injections, ...parse, failure };
    },
    dispose() {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtExceptionMonitor', onUnhandled);
      restoreParse();
      injection.dispose();
    },
  };
}
