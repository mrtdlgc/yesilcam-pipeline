import './environment.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export const hosted = process.env.APP_MODE === 'hosted';
if (process.env.APP_MODE && !['hosted', 'personal'].includes(process.env.APP_MODE))
  throw new Error('APP_MODE must be personal or hosted');

export interface Identity {
  userId: string;
  sessionId?: string;
}
const identities = new AsyncLocalStorage<Identity | undefined>();
export const identity = () => identities.getStore();
export function asIdentity<T>(value: Identity | undefined, operation: () => T): T {
  if (value && !/^[a-f0-9-]{36}$/.test(value.userId)) throw new Error('Invalid account identity');
  return identities.run(value, operation);
}
export const owns = (job: { ownerId?: string }) =>
  !hosted || Boolean(identity()?.userId && job.ownerId === identity()!.userId);
