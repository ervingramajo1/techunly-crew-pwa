import type { CrewDayStateRequest, CrewStopStateRequest } from './apiTypes';

const OFFLINE_QUEUE_KEY = 'techunly_crew_offline_queue';

export type CrewOfflineQueueType = 'day-state' | 'stop-action' | 'save-note';

export type CrewOfflineQueueItem = {
  id: string;
  type: CrewOfflineQueueType;
  timestamp: string;
  token: string;
  payload: CrewDayStateRequest | CrewStopStateRequest;
};

function readQueue(): CrewOfflineQueueItem[] {
  const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.type && item?.payload) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: CrewOfflineQueueItem[]): CrewOfflineQueueItem[] {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
  return items;
}

export function getCrewOfflineQueue(): CrewOfflineQueueItem[] {
  return readQueue();
}

export function enqueueCrewOfflineAction(
  type: CrewOfflineQueueType,
  token: string,
  payload: CrewDayStateRequest | CrewStopStateRequest,
  timestamp = new Date().toISOString()
): CrewOfflineQueueItem[] {
  const item: CrewOfflineQueueItem = {
    id: `${timestamp}-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp,
    token,
    payload
  };

  return writeQueue([...readQueue(), item]);
}

export function replaceCrewOfflineQueue(items: CrewOfflineQueueItem[]): CrewOfflineQueueItem[] {
  return writeQueue(items);
}
