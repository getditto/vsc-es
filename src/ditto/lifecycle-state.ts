export type LifecycleState =
  | { kind: 'idle' }
  | { kind: 'connecting'; targetConfigId: string }
  | { kind: 'active'; configId: string }
  | { kind: 'switching'; fromConfigId: string; toConfigId: string }
  | { kind: 'disconnecting'; configId: string }
  | { kind: 'error'; lastError: string };

export type LifecycleAction =
  | { type: 'connectStart'; configId: string }
  | { type: 'connectOk' }
  | { type: 'connectFail'; message: string }
  | { type: 'switchStart'; toConfigId: string }
  | { type: 'disconnectStart' }
  | { type: 'disconnectOk' }
  | { type: 'reset' };

export function reduceLifecycle(state: LifecycleState, action: LifecycleAction): LifecycleState {
  switch (action.type) {
    case 'connectStart':
      if (state.kind === 'idle' || state.kind === 'error') {
        return { kind: 'connecting', targetConfigId: action.configId };
      }
      if (state.kind === 'active' && state.configId !== action.configId) {
        return { kind: 'switching', fromConfigId: state.configId, toConfigId: action.configId };
      }
      return state;
    case 'connectOk':
      if (state.kind === 'connecting') return { kind: 'active', configId: state.targetConfigId };
      return state;
    case 'connectFail':
      return { kind: 'error', lastError: action.message };
    case 'switchStart':
      if (state.kind === 'active') return { kind: 'switching', fromConfigId: state.configId, toConfigId: action.toConfigId };
      return state;
    case 'disconnectStart':
      if (state.kind === 'active') return { kind: 'disconnecting', configId: state.configId };
      return state;
    case 'disconnectOk':
      if (state.kind === 'switching') return { kind: 'connecting', targetConfigId: state.toConfigId };
      if (state.kind === 'disconnecting') return { kind: 'idle' };
      return state;
    case 'reset':
      return { kind: 'idle' };
  }
}

export function isSwitchInProgress(state: LifecycleState): boolean {
  return state.kind === 'connecting' || state.kind === 'switching' || state.kind === 'disconnecting';
}
