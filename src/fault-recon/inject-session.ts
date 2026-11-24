import http from 'node:http';
import { realNow, realSetTimeout } from '../core/clock.js';
import type { CallMetadata } from '../fault-injector/call-capture.js';
import { installInjection, type InjectedEvent } from '../fault-injector/inject.js';
import type { ResponseWatch } from '../fault-injector/response-use.js';
import { INJECTORS } from '../fault-injector/injectors.js';
import { watchJsonParse } from '../fault-injector/malformed-json.js';
import { targetsSite } from './call-site.js';
import type { FaultMode, InjectedCall } from './protocol.js';
import type { BodyReport, Session, TestBody } from './runtime.js';

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

/** Answers every call the selected test bodies make to the site with the mode's fault, and nothing else. */
export function startInjection(mode: FaultMode, current: () => TestBody | undefined): Session {
  if (mode.faultKind === 'blackhole') throw new Error('the black hole holds calls; it is not injected');
  const inject = INJECTORS[mode.faultKind];
  if (inject === undefined) throw new Error(`chimpd cannot inject ${mode.faultKind} yet`);
  const selected = new Set(mode.testIds);
  const running = new Map<TestBody, RunningBody>();
  const owners = new WeakMap<CallMetadata, TestBody>();

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
    onInjected(event, metadata) {
      const owner = metadata === null ? undefined : owners.get(metadata);
      const active = owner === undefined ? undefined : running.get(owner);
      active?.injected.push({ metadata, call: recordOf(event, metadata) });
    },
    onResponse(metadata, watch) {
      const owner = owners.get(metadata);
      const active = owner === undefined ? undefined : running.get(owner);
      active?.responses.set(metadata, watch);
    },
  });

  const restoreParse =
    mode.faultKind === 'malformed-json'
      ? watchJsonParse(() => {
          const owner = current();
          const active = owner === undefined ? undefined : running.get(owner);
          if (active !== undefined) active.jsonParsed = true;
        })
      : () => undefined;

  return {
    includes: (task) => selected.has(task.id),
    begin(body) {
      running.set(body, { calls: [], targetedCalls: 0, injected: [], responses: new Map(), jsonParsed: false });
    },
    async end(body): Promise<BodyReport> {
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
      return { targetedCalls: active.targetedCalls, observations: [], injections, ...parse };
    },
    dispose() {
      restoreParse();
      injection.dispose();
    },
  };
}
