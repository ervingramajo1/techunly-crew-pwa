import { useEffect, useRef, useState } from 'react';
import type { CrewBootstrapData, CrewLoginData, CrewPhotoType, CrewStopStateAction } from './api/apiTypes';
import {
  CrewApiError,
  getCrewBootstrapApi,
  isCrewSessionValid,
  resolveValidatedCrewSession,
  saveCrewDayStateApi,
  saveCrewStopStateApi,
  uploadCrewPhotoApi,
  validateCrewSessionApi
} from './api/crewApi';
import {
  clearCrewToken,
  getCrewBootstrapCache,
  getCrewSession,
  getCrewToken,
  saveCrewBootstrapCache,
  saveCrewSession,
  saveCrewToken
} from './api/tokenStorage';
import {
  enqueueCrewOfflineAction,
  getCrewOfflineQueue,
  replaceCrewOfflineQueue,
  type CrewOfflineQueueItem,
  type CrewOfflineQueueType
} from './api/offlineQueue';
import { LoginScreen } from './auth/LoginScreen';
import { isCrewDeveloperMode } from './devMode';
import {
  browserLanguage,
  formatCrewDate,
  getTranslations,
  greetingForDate,
  resolveLanguage,
  type SupportedLanguage,
  type Translations
} from './i18n';

type DayStatus = 'not_started' | 'working' | 'on_lunch' | 'clocked_out';
type DayAction = 'clock_in' | 'lunch_start' | 'lunch_end' | 'clock_out' | 'reopen_day';
type StopAction = 'start_work' | 'finish_work';
type CrewView = 'dashboard' | 'route' | 'stopDetail';
type StopPhotoPreviews = Record<string, { before: string[]; after: string[] }>;
type EnlargedPhoto = { url: string; label: string } | null;
type BootstrapSource = 'none' | 'cache' | 'fresh' | 'merged-fresh' | 'optimistic';

function displayName(session: CrewLoginData | null, t: Translations): string {
  return String(
    session?.preferred_name ||
      session?.employee_name ||
      session?.name ||
      session?.email ||
      t.fallback.crewMember
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (value && typeof value === 'object') continue;
    const clean = String(value || '').trim();
    if (clean) return clean;
  }

  return '';
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateKeyFromValue(value: unknown): string {
  const raw = firstString(value);
  if (!raw) return '';
  const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}/);
  if (isoMatch) return isoMatch[0];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 10);
  return localDateKey(parsed);
}

function resolveBootstrapWorkDateKey(bootstrap: CrewBootstrapData | null): string {
  if (!bootstrap) return localDateKey();

  const explicitDate = dateKeyFromValue(bootstrap.route_date) || dateKeyFromValue(bootstrap.today_date);
  if (explicitDate) return explicitDate;

  const stopDate = getStops(bootstrap)
    .map((stop) => dateKeyFromValue(stop.route_date))
    .find(Boolean);
  if (stopDate) return stopDate;

  const routeDate = getRoutes(bootstrap)
    .map((route) => dateKeyFromValue(route.route_date))
    .find(Boolean);
  return routeDate || localDateKey();
}

function isBootstrapForToday(bootstrap: CrewBootstrapData | null): boolean {
  if (!bootstrap) return false;
  const today = localDateKey();
  const bootstrapDate = dateKeyFromValue(bootstrap.route_date);
  if (bootstrapDate && bootstrapDate !== today) return false;

  const stopDates = getStops(bootstrap)
    .map((stop) => dateKeyFromValue(stop.route_date))
    .filter(Boolean);
  if (stopDates.length) return stopDates.some((date) => date === today);

  const routeDates = getRoutes(bootstrap)
    .map((route) => dateKeyFromValue(route.route_date))
    .filter(Boolean);
  if (routeDates.length) return routeDates.some((date) => date === today);

  return false;
}

function filterBootstrapForCrewDate(
  bootstrap: CrewBootstrapData,
  dateKey = localDateKey(),
  allowPastRoutes = false
): CrewBootstrapData {
  if (allowPastRoutes) return bootstrap;

  const filterStops = (items: unknown): Record<string, unknown>[] | undefined => {
    if (!Array.isArray(items)) return undefined;
    return items.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      return dateKeyFromValue((item as Record<string, unknown>).route_date) === dateKey;
    }) as Record<string, unknown>[];
  };

  const next: CrewBootstrapData = {
    ...bootstrap,
    route_date: dateKey
  };

  const stops = filterStops(bootstrap.stops);
  if (stops) next.stops = stops;

  const assignments = filterStops(bootstrap.assignments);
  if (assignments) next.assignments = assignments;

  if (Array.isArray(bootstrap.routes)) {
    next.routes = bootstrap.routes
      .map((route) => {
        if (!route || typeof route !== 'object') return route;
        const record = route as Record<string, unknown>;
        const routeStops = filterStops(record.stops);
        const routeAssignments = filterStops(record.assignments);
        const routeProperties = filterStops(record.properties);
        const routeDate = dateKeyFromValue(record.route_date);

        return {
          ...record,
          route_date: routeDate || dateKey,
          ...(routeStops ? { stops: routeStops } : {}),
          ...(routeAssignments ? { assignments: routeAssignments } : {}),
          ...(routeProperties ? { properties: routeProperties } : {})
        };
      })
      .filter((route) => {
        if (!route || typeof route !== 'object') return false;
        const record = route as Record<string, unknown>;
        const routeDate = dateKeyFromValue(record.route_date);
        const nestedStops = [
          ...arrayFromUnknown(record.stops),
          ...arrayFromUnknown(record.assignments),
          ...arrayFromUnknown(record.properties)
        ];
        return routeDate === dateKey || nestedStops.length > 0;
      }) as Record<string, unknown>[];
  }

  if (Array.isArray(bootstrap.assigned_routes)) {
    next.assigned_routes = bootstrap.assigned_routes
      .map((route) => {
        if (!route || typeof route !== 'object') return route;
        const record = route as Record<string, unknown>;
        const routeStops = filterStops(record.stops);
        const routeAssignments = filterStops(record.assignments);
        return {
          ...record,
          ...(routeStops ? { stops: routeStops } : {}),
          ...(routeAssignments ? { assignments: routeAssignments } : {})
        };
      })
      .filter((route) => {
        if (!route || typeof route !== 'object') return false;
        const record = route as Record<string, unknown>;
        const routeDate = dateKeyFromValue(record.route_date);
        const nestedStops = [
          ...arrayFromUnknown(record.stops),
          ...arrayFromUnknown(record.assignments)
        ];
        return routeDate === dateKey || nestedStops.length > 0;
      }) as Record<string, unknown>[];
  }

  if (bootstrap.route && typeof bootstrap.route === 'object') {
    const route = bootstrap.route as Record<string, unknown>;
    const routeStops = filterStops(route.stops);
    const routeAssignments = filterStops(route.assignments);
    const routeDate = dateKeyFromValue(route.route_date);
    next.route = routeDate === dateKey || routeStops?.length || routeAssignments?.length
      ? {
          ...route,
          route_date: routeDate || dateKey,
          ...(routeStops ? { stops: routeStops } : {}),
          ...(routeAssignments ? { assignments: routeAssignments } : {})
        }
      : undefined;
  }

  if (Array.isArray(bootstrap.sessions)) {
    next.sessions = bootstrap.sessions.filter((row) => dateKeyFromValue(row.route_date) === dateKey);
  }

  return next;
}

function arrayFromUnknown(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as Record<string, unknown>[] : [];
}

function getRoutes(bootstrap: CrewBootstrapData | null): Record<string, unknown>[] {
  if (!bootstrap) return [];

  const routes = [
    ...arrayFromUnknown(bootstrap.routes),
    ...arrayFromUnknown(bootstrap.assigned_routes)
  ];

  if (bootstrap.route && typeof bootstrap.route === 'object') {
    routes.unshift(bootstrap.route);
  }

  return routes;
}

function getStops(bootstrap: CrewBootstrapData | null): Record<string, unknown>[] {
  if (!bootstrap) return [];

  const directStops = [
    ...arrayFromUnknown(bootstrap.stops),
    ...arrayFromUnknown(bootstrap.assignments)
  ];

  if (directStops.length) return directStops;

  return getRoutes(bootstrap).flatMap((route) => [
    ...arrayFromUnknown(route.stops),
    ...arrayFromUnknown(route.assignments),
    ...arrayFromUnknown(route.properties)
  ]);
}

function getCompletedStops(stops: Record<string, unknown>[]): Record<string, unknown>[] {
  return stops.filter(isCompletedStop);
}

function isCompletedStop(stop: Record<string, unknown>): boolean {
  const raw = firstString(
    stop.status,
    stop.stop_status,
    stop.route_status,
    stop.assignment_status,
    stop.work_order_status
  ).toLowerCase();

  return ['completed', 'complete', 'done', 'finished'].some((value) => raw.includes(value));
}

function stopId(stop: Record<string, unknown>): string {
  return firstString(stop.assignment_id, stop.route_assignment_id, stop.stop_id, stop.id);
}

function routeAssignmentId(stop: Record<string, unknown>): string {
  return firstString(stop.route_assignment_id, stop.assignment_id, stop.id);
}

function updateBootstrapStop(
  bootstrap: CrewBootstrapData | null,
  id: string,
  updatedStop: Record<string, unknown>
): CrewBootstrapData | null {
  if (!bootstrap || !id) return bootstrap;

  const updateList = (items: unknown): Record<string, unknown>[] | undefined => {
    if (!Array.isArray(items)) return undefined;
    return items.map((item) => {
      if (!item || typeof item !== 'object') return item as Record<string, unknown>;
      const record = item as Record<string, unknown>;
      return stopId(record) === id ? { ...record, ...updatedStop } : record;
    });
  };

  const next: CrewBootstrapData = { ...bootstrap };
  const stops = updateList(bootstrap.stops);
  const assignments = updateList(bootstrap.assignments);
  if (stops) next.stops = stops;
  if (assignments) next.assignments = assignments;

  const routes = Array.isArray(bootstrap.routes)
    ? bootstrap.routes.map((route) => {
        const nextRoute = { ...route };
        const routeStops = updateList(route.stops);
        const routeAssignments = updateList(route.assignments);
        const routeProperties = updateList(route.properties);
        if (routeStops) nextRoute.stops = routeStops;
        if (routeAssignments) nextRoute.assignments = routeAssignments;
        if (routeProperties) nextRoute.properties = routeProperties;
        return nextRoute;
      })
    : undefined;

  if (routes) next.routes = routes;
  return next;
}

function stopPhotoFieldPatch(
  incomingStop: Record<string, unknown>,
  existingStop?: Record<string, unknown>
): Record<string, string> {
  const existingIsNewer = stopUpdatedAtMs(existingStop) > stopUpdatedAtMs(incomingStop);
  const beforeUrl = existingIsNewer
    ? firstString(
        normalizePhotoUrl(existingStop?.before_photo_url),
        normalizePhotoUrl(existingStop?.before_photo),
        normalizePhotoUrl(incomingStop.before_photo_url),
        normalizePhotoUrl(incomingStop.before_photo)
      )
    : firstString(
        normalizePhotoUrl(incomingStop.before_photo_url),
        normalizePhotoUrl(incomingStop.before_photo),
        normalizePhotoUrl(existingStop?.before_photo_url),
        normalizePhotoUrl(existingStop?.before_photo)
      );
  const afterUrl = existingIsNewer
    ? firstString(
        normalizePhotoUrl(existingStop?.after_photo_url),
        normalizePhotoUrl(existingStop?.after_photo),
        normalizePhotoUrl(incomingStop.after_photo_url),
        normalizePhotoUrl(incomingStop.after_photo)
      )
    : firstString(
        normalizePhotoUrl(incomingStop.after_photo_url),
        normalizePhotoUrl(incomingStop.after_photo),
        normalizePhotoUrl(existingStop?.after_photo_url),
        normalizePhotoUrl(existingStop?.after_photo)
      );

  return {
    before_photo_url: beforeUrl,
    before_photo: beforeUrl,
    after_photo_url: afterUrl,
    after_photo: afterUrl,
    photo_url: firstString(beforeUrl, afterUrl, normalizePhotoUrl(incomingStop.photo_url), normalizePhotoUrl(existingStop?.photo_url))
  };
}

function stopUpdatedAtMs(stop?: Record<string, unknown>): number {
  const raw = firstString(
    stop?.updated_date,
    stop?.timestamp,
    stop?.reopened_at,
    stop?.clock_out_time,
    stop?.lunch_end_time,
    stop?.lunch_start_time,
    stop?.completed_at,
    stop?.check_in_time,
    stop?.clock_in_time
  );
  if (!raw) return 0;
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function mergeBootstrapPhotoFields(
  incoming: CrewBootstrapData | null,
  existing: CrewBootstrapData | null
): CrewBootstrapData | null {
  if (!incoming) return incoming;

  const existingById = new Map<string, Record<string, unknown>>();
  getStops(existing).forEach((stop) => {
    const id = routeAssignmentId(stop);
    if (id) existingById.set(id, stop);
  });

  const mergeStop = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== 'object') return item as Record<string, unknown>;
    const stop = item as Record<string, unknown>;
    const id = routeAssignmentId(stop);
    const existingStop = id ? existingById.get(id) : undefined;
    return {
      ...stop,
      ...stopPhotoFieldPatch(stop, existingStop)
    };
  };

  const mergeList = (items: unknown): Record<string, unknown>[] | undefined => {
    if (!Array.isArray(items)) return undefined;
    return items.map(mergeStop);
  };

  const next: CrewBootstrapData = { ...incoming };
  const stops = mergeList(incoming.stops);
  const assignments = mergeList(incoming.assignments);
  if (stops) next.stops = stops;
  if (assignments) next.assignments = assignments;

  if (Array.isArray(incoming.routes)) {
    next.routes = incoming.routes.map((route) => {
      const nextRoute = { ...route };
      const routeStops = mergeList(route.stops);
      const routeAssignments = mergeList(route.assignments);
      const routeProperties = mergeList(route.properties);
      if (routeStops) nextRoute.stops = routeStops;
      if (routeAssignments) nextRoute.assignments = routeAssignments;
      if (routeProperties) nextRoute.properties = routeProperties;
      return nextRoute;
    });
  }

  return next;
}

function stopPhotoDiagnostics(stop: Record<string, unknown> | null | undefined) {
  if (!stop) return null;

  return {
    route_assignment_id: firstString(stop.route_assignment_id, stop.assignment_id, stop.id),
    before_photo_url: firstString(stop.before_photo_url),
    after_photo_url: firstString(stop.after_photo_url),
    before_photo: firstString(stop.before_photo),
    after_photo: firstString(stop.after_photo),
    photo_url: firstString(stop.photo_url),
    updated_date: firstString(stop.updated_date),
    status: firstString(stop.stop_status, stop.status),
    raw: stop
  };
}

function getDaySessions(bootstrap: CrewBootstrapData | null): Record<string, unknown>[] {
  return arrayFromUnknown(bootstrap?.sessions);
}

function getCurrentDaySession(
  bootstrap: CrewBootstrapData | null,
  session: CrewLoginData | null,
  dateKey = localDateKey()
): Record<string, unknown> | null {
  const sessions = getDaySessions(bootstrap).filter((row) => dateKeyFromValue(row.route_date) === dateKey);
  if (!sessions.length) return null;

  const leaderId = firstString(
    bootstrap?.crew_session?.employee_id,
    bootstrap?.crew_session?.crew_id,
    session?.employee_id,
    session?.crew_id
  );

  if (!leaderId) return sessions[0];

  return sessions.find((row) => firstString(row.crew_leader_id, row.employee_id, row.crew_id) === leaderId) || sessions[0];
}

function updateBootstrapDaySession(
  bootstrap: CrewBootstrapData | null,
  session: CrewLoginData | null,
  action: DayAction,
  timestamp: string,
  routeDate: string
): CrewBootstrapData | null {
  if (!bootstrap) return bootstrap;

  const currentSession = getCurrentDaySession(bootstrap, session, routeDate || localDateKey());
  const leaderId = firstString(
    bootstrap.crew_session?.employee_id,
    bootstrap.crew_session?.crew_id,
    session?.employee_id,
    session?.crew_id
  );
  const leaderName = firstString(
    bootstrap.crew_session?.employee_name,
    bootstrap.crew_session?.full_name,
    session?.employee_name,
    session?.name
  );

  const nextSession: Record<string, unknown> = {
    ...(currentSession || {}),
    company_id: firstString(currentSession?.company_id, bootstrap.crew_session?.company_id, session?.company_id),
    crew_leader_id: firstString(currentSession?.crew_leader_id, leaderId),
    crew_leader_name: firstString(currentSession?.crew_leader_name, leaderName),
    route_date: firstString(routeDate, currentSession?.route_date, localDateKey()),
    updated_date: timestamp
  };

  if (action === 'clock_in') {
    nextSession.clock_in_time = timestamp;
    nextSession.status = 'Active';
  }
  if (action === 'lunch_start') {
    nextSession.lunch_start_time = timestamp;
    nextSession.status = 'Lunch';
  }
  if (action === 'lunch_end') {
    nextSession.lunch_end_time = timestamp;
    nextSession.status = 'Active';
  }
  if (action === 'clock_out') {
    nextSession.clock_out_time = timestamp;
    nextSession.status = 'Clocked Out';
  }
  if (action === 'reopen_day') {
    nextSession.reopened_at = timestamp;
    nextSession.status = 'Active';
  }

  const sessions = getDaySessions(bootstrap);
  const matched = currentSession
    ? sessions.some((row) => row === currentSession)
    : false;
  const nextSessions = matched
    ? sessions.map((row) => (row === currentSession ? nextSession : row))
    : [...sessions, nextSession];

  return {
    ...bootstrap,
    sessions: nextSessions
  };
}

function mergeBootstrapDayStateFields(
  incoming: CrewBootstrapData | null,
  existing: CrewBootstrapData | null,
  session: CrewLoginData | null
): CrewBootstrapData | null {
  if (!incoming) return incoming;

  const today = localDateKey();
  const incomingSession = getCurrentDaySession(incoming, session, today);
  const existingSession = getCurrentDaySession(existing, session, today);
  if (!existingSession) return incoming;
  if (incomingSession && stopUpdatedAtMs(incomingSession) >= stopUpdatedAtMs(existingSession)) return incoming;

  const sessions = getDaySessions(incoming).filter((row) => {
    const sameDate = dateKeyFromValue(row.route_date) === today;
    const sameLeader = firstString(row.crew_leader_id, row.employee_id, row.crew_id) === firstString(
      existingSession.crew_leader_id,
      existingSession.employee_id,
      existingSession.crew_id
    );
    return !(sameDate && sameLeader);
  });

  return {
    ...incoming,
    sessions: [...sessions, existingSession]
  };
}

function getDayStatus(daySession: Record<string, unknown> | null): DayStatus {
  if (!daySession) return 'not_started';

  const clockOut = firstString(daySession.clock_out_time);
  const lunchStart = firstString(daySession.lunch_start_time);
  const lunchEnd = firstString(daySession.lunch_end_time);
  const clockIn = firstString(daySession.clock_in_time);
  const reopenedAt = firstString(daySession.reopened_at);
  const status = firstString(daySession.status).toLowerCase();

  if (status.includes('lunch') && lunchStart && !lunchEnd) return 'on_lunch';
  if ((reopenedAt || clockOut) && (status.includes('active') || status.includes('working'))) return 'working';
  if (clockOut || status.includes('clocked out')) return 'clocked_out';
  if (lunchStart && !lunchEnd) return 'on_lunch';
  if (clockIn || status.includes('active')) return 'working';
  return 'not_started';
}

function resolveDayStateDiagnostics(
  bootstrap: CrewBootstrapData | null,
  session: CrewLoginData | null,
  source: BootstrapSource,
  cacheSyncedAt: string
): Record<string, unknown> {
  const todayDateKey = localDateKey();
  const sessions = getDaySessions(bootstrap);
  const selectedDaySession = getCurrentDaySession(bootstrap, session, todayDateKey);

  return {
    todayDateKey,
    bootstrapSource: source,
    cacheSyncedAt,
    bootstrapRouteDate: dateKeyFromValue(bootstrap?.route_date),
    routeDateKeys: getStops(bootstrap).map((stop) => dateKeyFromValue(stop.route_date)).filter(Boolean),
    sessionsReturned: sessions,
    selectedDaySession,
    resolvedDayStatus: getDayStatus(selectedDaySession),
    resolutionReason: selectedDaySession
      ? 'Matched a saved CrewAppSessions row for the current local date.'
      : 'No CrewAppSessions row matched the current local date.'
  };
}

function isLikelyNetworkFailure(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (err instanceof TypeError) return true;
  if (!(err instanceof CrewApiError)) return true;
  const message = String(err.message || '').toLowerCase();
  return message.includes('failed to fetch') ||
    message.includes('load failed') ||
    message.includes('network') ||
    message.includes('offline');
}

function dayStatusLabel(status: DayStatus, t: Translations): string {
  if (status === 'working') return t.day.working;
  if (status === 'on_lunch') return t.day.onLunch;
  if (status === 'clocked_out') return t.day.clockedOut;
  return t.day.notStarted;
}

function actionSuccessMessage(action: DayAction, t: Translations): string {
  if (action === 'clock_in') return t.day.startDaySuccess;
  if (action === 'lunch_start') return t.day.lunchStarted;
  if (action === 'lunch_end') return t.day.backFromLunch;
  if (action === 'reopen_day') return t.day.dayReopened;
  return t.day.clockOutSuccess;
}

function formatCrewTime(value: unknown, language: SupportedLanguage, t: Translations): string {
  const raw = firstString(value);
  if (!raw) return t.day.notAvailable;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  return new Intl.DateTimeFormat(language === 'es' ? 'es-US' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function stopTimestamp(
  stop: Record<string, unknown>,
  keys: string[],
  language: SupportedLanguage,
  t: Translations
): string {
  for (const key of keys) {
    const value = firstString(stop[key]);
    if (value) return formatCrewTime(value, language, t);
  }

  return t.day.notAvailable;
}

function stopPhotoUrls(stop: Record<string, unknown>, type: CrewPhotoType): string[] {
  return filteredStopPhotoUrls(stop, type);
}

function rawStopPhotoUrlValues(stop: Record<string, unknown>, type: CrewPhotoType): string[] {
  const values = type === 'before'
    ? [
        stop.before_photo_url,
        stop.before_photo,
        stop.photo_url
      ]
    : [
        stop.after_photo_url,
        stop.after_photo,
        stop.photo_url
      ];

  return values.flatMap(splitPhotoUrlValue).filter(Boolean);
}

function splitPhotoUrlValue(value: unknown): string[] {
  const raw = firstString(value);
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw) || raw.startsWith('blob:') || /^data:image\//i.test(raw)) return [raw];
  return raw.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function filteredStopPhotoUrls(stop: Record<string, unknown>, type: CrewPhotoType): string[] {
  const seen = new Set<string>();
  return rawStopPhotoUrlValues(stop, type)
    .map(normalizePhotoUrl)
    .filter(isRenderablePhotoUrl)
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function isRenderablePhotoUrl(value: string): boolean {
  const clean = String(value || '').trim();
  if (!clean) return false;

  const lowered = clean.toLowerCase();
  if (
    lowered === 'null' ||
    lowered === 'undefined' ||
    lowered === 'none' ||
    lowered === 'n/a' ||
    lowered === 'na' ||
    lowered === '-' ||
    lowered === '#'
  ) {
    return false;
  }

  if (clean.startsWith('blob:')) return true;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(clean)) return true;

  try {
    const url = new URL(clean);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isLocalPreviewPhotoUrl(value: string): boolean {
  const clean = String(value || '').trim();
  return clean.startsWith('blob:') || /^data:image\/[a-z0-9.+-]+;base64,/i.test(clean);
}

function isPersistedBackendPhotoUrl(value: string): boolean {
  const clean = String(value || '').trim();
  if (!clean || isLocalPreviewPhotoUrl(clean)) return false;

  try {
    const url = new URL(clean);
    const host = url.hostname.toLowerCase();
    return (
      host === 'drive.google.com' ||
      host.endsWith('.googleusercontent.com') ||
      (host === 'drive.google.com' && url.pathname === '/uc' && url.searchParams.has('id'))
    );
  } catch {
    return false;
  }
}

function openPersistedPhotoUrl(url: string) {
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) window.location.href = url;
  } catch {
    window.location.href = url;
  }
}

function normalizePhotoUrl(value: unknown): string {
  const raw = firstString(value);
  if (!raw) return '';

  const driveOpenMatch = raw.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/);
  if (driveOpenMatch?.[1]) {
    return `https://drive.google.com/uc?export=view&id=${driveOpenMatch[1]}`;
  }

  try {
    const url = new URL(raw);
    if (url.hostname === 'drive.google.com') {
      const id = url.searchParams.get('id');
      if (id) return `https://drive.google.com/uc?export=view&id=${id}`;
    }
  } catch {
    return raw;
  }

  return raw;
}

function photoUrlFromUploadResult(result: Record<string, unknown>, type: CrewPhotoType): string {
  return normalizePhotoUrl(firstString(
    result.saved_photo_url,
    result[type === 'before' ? 'before_photo_url' : 'after_photo_url'],
    result.photo_url,
    result.file_url,
    result.drive_url,
    result.url,
    result.web_content_link,
    result.webContentLink
  ));
}

function revokePhotoPreviewUrls(previews: StopPhotoPreviews) {
  Object.values(previews).forEach((group) => {
    [...group.before, ...group.after].forEach((url) => {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    });
  });
}

function PhotoThumbnail({
  alt,
  onOpen,
  t,
  url
}: {
  alt: string;
  onOpen: (url: string) => void;
  t: Translations;
  url: string;
}) {
  const [hasError, setHasError] = useState(false);

  if (!url) return null;

  if (hasError) {
    return (
      <div className="crew-photo-saved-card">
        <strong>{t.stop.photoSaved}</strong>
        <button
          className="crew-photo-view-link"
          onClick={() => onOpen(url)}
          type="button"
        >
          {t.stop.viewPhoto}
        </button>
      </div>
    );
  }

  return (
    <button className="crew-photo-thumbnail-button" onClick={() => onOpen(url)} type="button">
      <img
        alt={alt}
        onError={() => setHasError(true)}
        src={url}
      />
    </button>
  );
}

function EnlargedPhotoModal({
  label,
  onClose,
  t,
  url
}: {
  label: string;
  onClose: () => void;
  t: Translations;
  url: string;
}) {
  const [hasError, setHasError] = useState(false);

  return (
    <div className="crew-photo-modal" role="dialog" aria-modal="true" aria-label={label}>
      <button className="crew-photo-modal-backdrop" onClick={onClose} type="button" aria-label={t.stop.closePhoto} />
      <div className="crew-photo-modal-content">
        <button className="crew-photo-modal-close" onClick={onClose} type="button">
          {t.stop.closePhoto}
        </button>
        {hasError ? (
          <div className="crew-photo-modal-placeholder" role="img" aria-label={t.stop.photoUnavailable}>
            {t.stop.photoUnavailable}
          </div>
        ) : (
          <img alt={label} onError={() => setHasError(true)} src={url} />
        )}
      </div>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read image.'));
    reader.readAsDataURL(file);
  });
}

function formatLastSynced(value: string, language: SupportedLanguage): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(language === 'es' ? 'es-US' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

function routeTitle(route: Record<string, unknown> | undefined, t: Translations): string {
  if (!route) return t.dashboard.routeFallback;

  return firstString(route.route_name, route.name, route.title, route.route_id) || t.dashboard.routeFallback;
}

function nestedValue(source: Record<string, unknown>, key: string): unknown {
  const value = source[key];
  if (value && typeof value === 'object') return value;
  return undefined;
}

function stopText(stop: Record<string, unknown>, keys: string[], fallback: string): string {
  const property = nestedValue(stop, 'property') as Record<string, unknown> | undefined;
  const client = nestedValue(stop, 'client') as Record<string, unknown> | undefined;
  const workOrder = nestedValue(stop, 'work_order') as Record<string, unknown> | undefined;
  const service = nestedValue(stop, 'service') as Record<string, unknown> | undefined;

  for (const key of keys) {
    const value = firstString(
      stop[key],
      property?.[key],
      client?.[key],
      workOrder?.[key],
      service?.[key]
    );

    if (value) return value;
  }

  return fallback;
}

function normalizeStopStatusKey(stop: Record<string, unknown>): keyof Translations['status'] {
  const raw = firstString(
    stop.status,
    stop.stop_status,
    stop.route_status,
    stop.assignment_status,
    stop.work_order_status
  ).toLowerCase();

  if (raw.includes('complete') || raw.includes('completed') || raw.includes('done') || raw.includes('finished')) return 'completed';
  if (raw.includes('progress') || raw.includes('started') || raw.includes('active')) return 'inProgress';
  return 'pending';
}

function stopStatusLabel(stop: Record<string, unknown>, t: Translations): string {
  return t.status[normalizeStopStatusKey(stop)];
}

function roleLabel(value: unknown, t: Translations): string {
  const raw = firstString(value);
  if (!raw) return t.dashboard.roleCrewMember;

  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'crew_leader' || normalized === 'leader') return t.dashboard.roleCrewLeader;
  if (normalized === 'crew_member' || normalized === 'crew_worker' || normalized === 'worker') return t.dashboard.roleCrewMember;
  if (normalized === 'admin' || normalized === 'administrator') return t.dashboard.roleAdmin;

  return raw.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stopScheduledDate(stop: Record<string, unknown>, language: SupportedLanguage, t: Translations): string {
  const raw = firstString(stop.scheduled_date, stop.service_date, stop.route_date, stop.date);
  if (!raw) return t.route.noScheduledDate;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  return formatCrewDate(date, language);
}

function preferredLanguageFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  return firstString(
    record.preferred_language,
    record.preferredLanguage,
    record.language,
    record.employee_language,
    record.employeeLanguage,
    record.preferred_lang,
    record.lang
  );
}

function resolveCrewLanguage(
  session: CrewLoginData | null,
  bootstrap: CrewBootstrapData | null
): SupportedLanguage {
  return resolveLanguage(
    preferredLanguageFrom(bootstrap?.employee),
    preferredLanguageFrom(bootstrap?.session),
    preferredLanguageFrom(bootstrap),
    preferredLanguageFrom(session),
    browserLanguage()
  );
}

export function App() {
  const [token, setToken] = useState('');
  const [session, setSession] = useState<CrewLoginData | null>(null);
  const [bootstrap, setBootstrap] = useState<CrewBootstrapData | null>(null);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [currentView, setCurrentView] = useState<CrewView>('dashboard');
  const [selectedStop, setSelectedStop] = useState<Record<string, unknown> | null>(null);
  const [isSavingDayState, setIsSavingDayState] = useState(false);
  const [dayStateMessage, setDayStateMessage] = useState('');
  const [dayStateError, setDayStateError] = useState('');
  const [dayStateDiagnostics, setDayStateDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [isSyncingOfflineQueue, setIsSyncingOfflineQueue] = useState(false);
  const [pendingQueueCount, setPendingQueueCount] = useState(() => getCrewOfflineQueue().length);
  const [cacheWarning, setCacheWarning] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState('');
  const [bootstrapSource, setBootstrapSource] = useState<BootstrapSource>('none');
  const [isSavingStopState, setIsSavingStopState] = useState(false);
  const [stopStateMessage, setStopStateMessage] = useState('');
  const [stopStateError, setStopStateError] = useState('');
  const [stopActionDiagnostics, setStopActionDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [crewNoteDraft, setCrewNoteDraft] = useState('');
  const [isSavingCrewNote, setIsSavingCrewNote] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState<CrewPhotoType | ''>('');
  const [photoPreviews, setPhotoPreviews] = useState<StopPhotoPreviews>({});
  const [enlargedPhoto, setEnlargedPhoto] = useState<EnlargedPhoto>(null);
  const photoPreviewsRef = useRef<StopPhotoPreviews>({});
  const language = resolveCrewLanguage(session, bootstrap);
  const t = getTranslations(language);
  const isDeveloperMode = isCrewDeveloperMode();

  useEffect(() => {
    photoPreviewsRef.current = photoPreviews;
  }, [photoPreviews]);

  useEffect(() => {
    return () => {
      revokePhotoPreviewUrls(photoPreviewsRef.current);
    };
  }, []);

  useEffect(() => {
    const updateOnlineStatus = () => {
      setIsOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
      refreshQueueCount();
    };

    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();

    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    if (isOnline && pendingQueueCount > 0) {
      void syncOfflineQueue();
    }
  }, [isOnline, pendingQueueCount]);

  function clearPhotoPreviews() {
    revokePhotoPreviewUrls(photoPreviewsRef.current);
    photoPreviewsRef.current = {};
    setPhotoPreviews({});
  }

  function cacheAndSetBootstrap(
    nextBootstrap: CrewBootstrapData,
    existingBootstrap: CrewBootstrapData | null = bootstrap,
    source: BootstrapSource = 'merged-fresh'
  ) {
    const workDateKey = resolveBootstrapWorkDateKey(nextBootstrap);
    const dateFilteredBootstrap = filterBootstrapForCrewDate(nextBootstrap, workDateKey, isDeveloperMode);
    const photoMergedBootstrap = mergeBootstrapPhotoFields(dateFilteredBootstrap, existingBootstrap) || dateFilteredBootstrap;
    const mergedBootstrap = mergeBootstrapDayStateFields(photoMergedBootstrap, existingBootstrap, session) || photoMergedBootstrap;
    const cache = saveCrewBootstrapCache(mergedBootstrap);
    setBootstrap(mergedBootstrap);
    setLastSyncedAt(cache.syncedAt);
    setBootstrapSource(source);
    return {
      bootstrap: mergedBootstrap,
      syncedAt: cache.syncedAt
    };
  }

  function refreshQueueCount() {
    setPendingQueueCount(getCrewOfflineQueue().length);
  }

  function enqueueOfflineAction(
    type: CrewOfflineQueueType,
    actionToken: string,
    payload: CrewOfflineQueueItem['payload']
  ) {
    const nextQueue = enqueueCrewOfflineAction(type, actionToken, payload, firstString((payload as Record<string, unknown>).timestamp, new Date().toISOString()));
    setPendingQueueCount(nextQueue.length);
  }

  async function performQueuedAction(item: CrewOfflineQueueItem) {
    if (item.type === 'day-state') {
      await saveCrewDayStateApi(item.payload as Parameters<typeof saveCrewDayStateApi>[0]);
      return;
    }

    await saveCrewStopStateApi(item.payload as Parameters<typeof saveCrewStopStateApi>[0]);
  }

  async function syncOfflineQueue() {
    if (isSyncingOfflineQueue || (typeof navigator !== 'undefined' && !navigator.onLine)) return;

    const queue = getCrewOfflineQueue();
    if (!queue.length) {
      setPendingQueueCount(0);
      return;
    }

    setIsSyncingOfflineQueue(true);
    let remaining = [...queue];

    try {
      while (remaining.length) {
        const [item, ...rest] = remaining;
        await performQueuedAction(item);
        remaining = replaceCrewOfflineQueue(rest);
        setPendingQueueCount(remaining.length);
      }

      const currentToken = token || getCrewToken();
      if (currentToken) {
        try {
          const workspace = await getCrewBootstrapApi(crewBootstrapRequest(currentToken));
          cacheAndSetBootstrap(workspace, bootstrap, 'merged-fresh');
          setCacheWarning('');
        } catch {
          setCacheWarning(t.states.usingLastSavedData);
        }
      }
    } catch {
      setPendingQueueCount(remaining.length);
    } finally {
      setIsSyncingOfflineQueue(false);
    }
  }

  function openCrewPhoto(url: string, label: string) {
    if (isLocalPreviewPhotoUrl(url)) {
      setEnlargedPhoto({ url, label });
      return;
    }

    if (isPersistedBackendPhotoUrl(url)) {
      openPersistedPhotoUrl(url);
      return;
    }

    openPersistedPhotoUrl(url);
  }

  function crewBootstrapRequest(currentToken: string) {
    return {
      token: currentToken,
      allow_past_route: isDeveloperMode
    };
  }

  useEffect(() => {
    let isMounted = true;

    async function restoreSession() {
      const storedToken = getCrewToken();

      if (!storedToken) {
        if (isMounted) setIsRestoringSession(false);
        return;
      }

      const cachedBootstrap = getCrewBootstrapCache<CrewBootstrapData>();
      const cachedSession = getCrewSession<CrewLoginData>();

      if (cachedBootstrap && isBootstrapForToday(cachedBootstrap.bootstrap)) {
        if (isMounted) {
          setToken(storedToken);
          setSession(cachedSession);
          setBootstrap(cachedBootstrap.bootstrap);
          setBootstrapSource('cache');
          setLastSyncedAt(cachedBootstrap.syncedAt);
          setWorkspaceDiagnostics(null);
          setWorkspaceError('');
          setCurrentView('dashboard');
          setSelectedStop(null);
          setDayStateMessage('');
          setDayStateError('');
          setDayStateDiagnostics(null);
          setStopStateMessage('');
          setStopStateError('');
          setStopActionDiagnostics(null);
          setCrewNoteDraft('');
          setEnlargedPhoto(null);
          clearPhotoPreviews();
          setCacheWarning('');
          setIsRestoringSession(false);
          setIsSyncing(true);
        }

        try {
          const validatedSession = await validateCrewSessionApi({ token: storedToken });

          if (!isCrewSessionValid(validatedSession)) {
            throw new Error(t.errors.sessionInvalid);
          }

          const restoredSession = resolveValidatedCrewSession(validatedSession, storedToken);
          saveCrewSession(restoredSession);

          if (isMounted) setSession(restoredSession);

          try {
            const workspace = await getCrewBootstrapApi(crewBootstrapRequest(storedToken));

            if (isMounted) {
              cacheAndSetBootstrap(workspace, cachedBootstrap.bootstrap);
              setCacheWarning('');
              setWorkspaceDiagnostics(null);
              setWorkspaceError('');
            }
          } catch (err) {
            if (isMounted) {
              setCacheWarning(t.states.usingLastSavedData);
              setWorkspaceDiagnostics(err instanceof CrewApiError ? err.diagnostics : {
                exceptionMessage: err instanceof Error ? err.message : String(err)
              });
            }
          }
        } catch {
          clearCrewToken();

          if (isMounted) {
            setToken('');
            setSession(null);
            setBootstrap(null);
            setBootstrapSource('none');
            setLastSyncedAt('');
            setWorkspaceDiagnostics(null);
            setWorkspaceError('');
            setCurrentView('dashboard');
            setSelectedStop(null);
            setDayStateMessage('');
            setDayStateError('');
            setDayStateDiagnostics(null);
            setStopStateMessage('');
            setStopStateError('');
            setStopActionDiagnostics(null);
            setCrewNoteDraft('');
            setEnlargedPhoto(null);
            clearPhotoPreviews();
            setCacheWarning('');
          }
        } finally {
          if (isMounted) setIsSyncing(false);
        }

        return;
      }

      try {
        const validatedSession = await validateCrewSessionApi({ token: storedToken });

        if (!isCrewSessionValid(validatedSession)) {
          throw new Error(t.errors.sessionInvalid);
        }

        const restoredSession = resolveValidatedCrewSession(validatedSession, storedToken);
        const workspace = await getCrewBootstrapApi(crewBootstrapRequest(storedToken));
        saveCrewSession(restoredSession);

        if (isMounted) {
          setToken(storedToken);
          setSession(restoredSession);
          cacheAndSetBootstrap(workspace, null);
          setWorkspaceDiagnostics(null);
          setCurrentView('dashboard');
          setSelectedStop(null);
          setDayStateMessage('');
          setDayStateError('');
          setDayStateDiagnostics(null);
          setStopStateMessage('');
          setStopStateError('');
          setStopActionDiagnostics(null);
          setCrewNoteDraft('');
          setEnlargedPhoto(null);
          clearPhotoPreviews();
        }
      } catch {
        clearCrewToken();

        if (isMounted) {
          setToken('');
          setSession(null);
          setBootstrap(null);
          setBootstrapSource('none');
          setLastSyncedAt('');
          setWorkspaceDiagnostics(null);
          setCurrentView('dashboard');
          setSelectedStop(null);
          setDayStateMessage('');
          setDayStateError('');
          setDayStateDiagnostics(null);
          setStopStateMessage('');
          setStopStateError('');
          setStopActionDiagnostics(null);
          setCrewNoteDraft('');
        }
      } finally {
        if (isMounted) setIsRestoringSession(false);
      }
    }

    restoreSession();

    return () => {
      isMounted = false;
    };
  }, []);

  async function loadWorkspace(nextToken: string) {
    setWorkspaceError('');
    setWorkspaceDiagnostics(null);
    setIsLoadingWorkspace(true);

    try {
      const workspace = await getCrewBootstrapApi(crewBootstrapRequest(nextToken));
      cacheAndSetBootstrap(workspace, bootstrap);
      setCacheWarning('');
    } catch (err) {
      setBootstrap(null);
      setBootstrapSource('none');
      setWorkspaceError(t.states.unableToLoadWorkspace);
      setWorkspaceDiagnostics(err instanceof CrewApiError ? err.diagnostics : {
        exceptionMessage: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setIsLoadingWorkspace(false);
    }
  }

  function handleLogin(nextToken: string, nextSession: CrewLoginData) {
    saveCrewToken(nextToken);
    saveCrewSession(nextSession);
    setToken(nextToken);
    setSession(nextSession);
    setCurrentView('dashboard');
    setSelectedStop(null);
    setDayStateMessage('');
    setDayStateError('');
    setDayStateDiagnostics(null);
    setStopStateMessage('');
    setStopStateError('');
    setStopActionDiagnostics(null);
    setCrewNoteDraft('');
    setEnlargedPhoto(null);
    clearPhotoPreviews();
    void loadWorkspace(nextToken);
  }

  async function handleDayAction(action: DayAction) {
    setDayStateMessage('');
    setDayStateError('');
    setDayStateDiagnostics(null);
    setIsSavingDayState(true);
    const actionTimestamp = new Date().toISOString();
    const payload = {
      token,
      action,
      timestamp: actionTimestamp,
      route_date: localDateKey(),
      session_date: localDateKey(),
      local_date_key: localDateKey()
    };

    try {
      const dayResult = await saveCrewDayStateApi(payload);
      const savedTimestamp = firstString(dayResult.timestamp, actionTimestamp);
      const optimisticBootstrap = updateBootstrapDaySession(
        bootstrap,
        session,
        action,
        savedTimestamp,
        firstString(payload.route_date)
      );

      if (optimisticBootstrap) {
        cacheAndSetBootstrap(optimisticBootstrap, bootstrap, 'optimistic');
      }
      setDayStateMessage(actionSuccessMessage(action, t));
      setDayStateDiagnostics({
        phase: 'success',
        action,
        requestPayload: payload,
        responseData: dayResult
      });
      setCacheWarning('');
      setIsSavingDayState(false);

      void (async () => {
        try {
          const workspace = await getCrewBootstrapApi(crewBootstrapRequest(token));
          cacheAndSetBootstrap(workspace, optimisticBootstrap, 'merged-fresh');
          setCacheWarning('');
        } catch (err) {
          setCacheWarning(t.states.usingLastSavedData);
          setDayStateDiagnostics({
            phase: 'success-bootstrap-refresh-failed',
            action,
            requestPayload: payload,
            responseData: dayResult,
            exceptionMessage: err instanceof Error ? err.message : String(err),
            diagnostics: err instanceof CrewApiError ? err.diagnostics : null
          });
        }
      })();
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        const optimisticBootstrap = updateBootstrapDaySession(
          bootstrap,
          session,
          action,
          actionTimestamp,
          firstString(payload.route_date)
        );
        if (optimisticBootstrap) {
          cacheAndSetBootstrap(optimisticBootstrap, bootstrap, 'optimistic');
        }
        enqueueOfflineAction('day-state', token, payload);
        setDayStateMessage(t.states.savedOffline);
        setDayStateError('');
        setDayStateDiagnostics({
          phase: 'queued-offline',
          action,
          requestPayload: payload,
          exceptionMessage: err instanceof Error ? err.message : String(err),
          diagnostics: err instanceof CrewApiError ? err.diagnostics : null
        });
        return;
      }

      setDayStateError(action === 'reopen_day' ? t.day.reopenDayFailed : t.day.updateFailed);
      setDayStateDiagnostics({
        phase: 'failure',
        action,
        requestPayload: payload,
        exceptionMessage: err instanceof Error ? err.message : String(err),
        diagnostics: err instanceof CrewApiError ? err.diagnostics : null
      });
    } finally {
      setIsSavingDayState(false);
    }
  }

  async function handleStopAction(action: StopAction, stop: Record<string, unknown>) {
    const id = stopId(stop);
    const routeAssignmentId = firstString(stop.route_assignment_id, stop.assignment_id, stop.id);
    const backendAction: CrewStopStateAction = action === 'start_work' ? 'check_in' : 'complete_stop';
    const payload = {
      token,
      action: backendAction,
      timestamp: new Date().toISOString(),
      stop_id: id,
      assignment_id: firstString(stop.assignment_id, stop.id),
      route_assignment_id: routeAssignmentId,
      service_id: firstString(stop.service_id),
      work_order_id: firstString(stop.work_order_id),
      crew_id: firstString(stop.crew_id),
      route_date: firstString(stop.route_date),
      route_day: firstString(stop.route_day)
    };
    if (!id) {
      setStopStateError(t.stop.updateFailed);
      setStopActionDiagnostics({
        phase: 'payload-validation',
        backendAction,
        requestPayload: payload,
        stop
      });
      return;
    }

    setStopStateMessage('');
    setStopStateError('');
    setStopActionDiagnostics({
      phase: 'request-started',
      backendAction,
      requestPayload: payload,
      stop
    });
    setIsSavingStopState(true);

    try {
      const stopResult = await saveCrewStopStateApi(payload);
      const actionTimestamp = firstString(stopResult.timestamp, stopResult.completed_at, stopResult.check_in_time, payload.timestamp);
      const optimisticStop: Record<string, unknown> = {
        ...stop,
        status: action === 'start_work' ? 'In Progress' : 'Completed',
        stop_status: action === 'start_work' ? 'In Progress' : 'Completed',
        updated_date: actionTimestamp
      };

      if (action === 'start_work') {
        optimisticStop.check_in_time = firstString(stopResult.check_in_time, stop.check_in_time, actionTimestamp);
        optimisticStop.in_progress_at = firstString(stop.in_progress_at, actionTimestamp);
      } else {
        optimisticStop.completed_at = firstString(stopResult.completed_at, actionTimestamp);
        optimisticStop.completed_time = firstString(stopResult.completed_time, stopResult.completed_at, actionTimestamp);
        optimisticStop.completion_time = firstString(stopResult.completion_time, stopResult.completed_at, actionTimestamp);
        optimisticStop.finished_at = firstString(stopResult.finished_at, stopResult.completed_at, actionTimestamp);
        optimisticStop.work_finished_at = firstString(stopResult.work_finished_at, stopResult.completed_at, actionTimestamp);
        optimisticStop.check_out_time = firstString(stopResult.check_out_time, stopResult.completed_at, actionTimestamp);
      }

      const optimisticBootstrap = updateBootstrapStop(bootstrap, id, optimisticStop);
      if (optimisticBootstrap) {
        cacheAndSetBootstrap(optimisticBootstrap, bootstrap, 'optimistic');
      }
      setSelectedStop(optimisticStop);
      setCacheWarning('');
      setStopStateMessage(action === 'start_work' ? t.stop.startWorkSuccess : t.stop.finishWorkSuccess);
      setStopActionDiagnostics({
        phase: 'success',
        backendAction,
        requestPayload: payload,
        responseData: stopResult
      });
      setIsSavingStopState(false);

      void (async () => {
        try {
          const workspace = await getCrewBootstrapApi(crewBootstrapRequest(token));
          const merged = cacheAndSetBootstrap(workspace, optimisticBootstrap, 'merged-fresh').bootstrap;
          const refreshedStop = getStops(merged).find((item) => stopId(item) === id);
          setSelectedStop(refreshedStop || optimisticStop);
          setCacheWarning('');
        } catch (err) {
          setCacheWarning(t.states.usingLastSavedData);
          setStopActionDiagnostics({
            phase: 'success-bootstrap-refresh-failed',
            backendAction,
            requestPayload: payload,
            responseData: stopResult,
            exceptionMessage: err instanceof Error ? err.message : String(err),
            diagnostics: err instanceof CrewApiError ? err.diagnostics : null
          });
        }
      })();
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        const actionTimestamp = firstString(payload.timestamp, new Date().toISOString());
        const optimisticStop: Record<string, unknown> = {
          ...stop,
          status: action === 'start_work' ? 'In Progress' : 'Completed',
          stop_status: action === 'start_work' ? 'In Progress' : 'Completed',
          updated_date: actionTimestamp
        };

        if (action === 'start_work') {
          optimisticStop.check_in_time = firstString(stop.check_in_time, actionTimestamp);
          optimisticStop.in_progress_at = firstString(stop.in_progress_at, actionTimestamp);
        } else {
          optimisticStop.completed_at = actionTimestamp;
          optimisticStop.completed_time = actionTimestamp;
          optimisticStop.completion_time = actionTimestamp;
          optimisticStop.finished_at = actionTimestamp;
          optimisticStop.work_finished_at = actionTimestamp;
          optimisticStop.check_out_time = actionTimestamp;
        }

        const optimisticBootstrap = updateBootstrapStop(bootstrap, id, optimisticStop);
        if (optimisticBootstrap) {
          cacheAndSetBootstrap(optimisticBootstrap, bootstrap, 'optimistic');
        }
        setSelectedStop(optimisticStop);
        enqueueOfflineAction('stop-action', token, payload);
        setStopStateMessage(t.states.savedOffline);
        setStopStateError('');
        setStopActionDiagnostics({
          phase: 'queued-offline',
          backendAction,
          requestPayload: payload,
          exceptionMessage: err instanceof Error ? err.message : String(err),
          diagnostics: err instanceof CrewApiError ? err.diagnostics : null
        });
        setIsSavingStopState(false);
        return;
      }

      setStopStateError(t.stop.updateFailed);
      setStopActionDiagnostics({
        phase: 'failure',
        backendAction,
        requestPayload: payload,
        backendErrorMessage: err instanceof Error ? err.message : String(err),
        exceptionMessage: err instanceof Error ? err.message : String(err),
        diagnostics: err instanceof CrewApiError ? err.diagnostics : null
      });
      setIsSavingStopState(false);
    }
  }

  async function refreshStopInBackground(
    id: string,
    fallbackStop: Record<string, unknown>,
    diagnostics?: Record<string, unknown>
  ) {
    try {
      const workspace = await getCrewBootstrapApi(crewBootstrapRequest(token));
      const merged = cacheAndSetBootstrap(workspace, bootstrap, 'merged-fresh').bootstrap;
      const refreshedStop = getStops(merged).find((item) => stopId(item) === id);
      setSelectedStop(refreshedStop || fallbackStop);
      setCacheWarning('');
      if (diagnostics) {
        setStopActionDiagnostics({
          ...diagnostics,
          bootstrapRefresh: {
            foundStop: !!refreshedStop,
            route_assignment_id: refreshedStop ? firstString(refreshedStop.route_assignment_id) : '',
            before_photo_url: refreshedStop ? firstString(refreshedStop.before_photo_url) : '',
            after_photo_url: refreshedStop ? firstString(refreshedStop.after_photo_url) : '',
            photo_url: refreshedStop ? firstString(refreshedStop.photo_url) : ''
          }
        });
      }
    } catch (err) {
      setCacheWarning(t.states.usingLastSavedData);
      setStopActionDiagnostics({
        ...(diagnostics || {}),
        phase: 'background-bootstrap-refresh-failed',
        exceptionMessage: err instanceof Error ? err.message : String(err),
        diagnostics: err instanceof CrewApiError ? err.diagnostics : null
      });
    }
  }

  async function handleSaveCrewNote(stop: Record<string, unknown>) {
    const cleanNote = crewNoteDraft.trim();
    const id = stopId(stop);
    const cleanRouteAssignmentId = routeAssignmentId(stop);
    if (!cleanNote || !cleanRouteAssignmentId) return;

    const payload = {
      token,
      action: 'add_note' as CrewStopStateAction,
      timestamp: new Date().toISOString(),
      stop_id: id,
      route_assignment_id: cleanRouteAssignmentId,
      service_id: firstString(stop.service_id),
      work_order_id: firstString(stop.work_order_id),
      crew_id: firstString(stop.crew_id),
      route_date: firstString(stop.route_date),
      route_day: firstString(stop.route_day),
      crew_note: cleanNote
    };

    setIsSavingCrewNote(true);
    setStopStateMessage('');
    setStopStateError('');
    setStopActionDiagnostics({ phase: 'note-save-started', requestPayload: payload });

    try {
      const result = await saveCrewStopStateApi(payload);
      const optimisticStop = {
        ...stop,
        crew_note: cleanNote,
        notes: firstString(stop.notes) || cleanNote
      };
      const optimisticBootstrap = updateBootstrapStop(bootstrap, id, optimisticStop);
      if (optimisticBootstrap) cacheAndSetBootstrap(optimisticBootstrap, bootstrap, 'optimistic');
      setSelectedStop(optimisticStop);
      setStopStateMessage(t.stop.notesSaved);
      setStopActionDiagnostics({ phase: 'note-save-success', requestPayload: payload, responseData: result });
      void refreshStopInBackground(id, optimisticStop);
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        const optimisticStop = {
          ...stop,
          crew_note: cleanNote,
          notes: firstString(stop.notes) || cleanNote,
          updated_date: firstString(payload.timestamp, new Date().toISOString())
        };
        const optimisticBootstrap = updateBootstrapStop(bootstrap, id, optimisticStop);
        if (optimisticBootstrap) cacheAndSetBootstrap(optimisticBootstrap, bootstrap, 'optimistic');
        setSelectedStop(optimisticStop);
        enqueueOfflineAction('save-note', token, payload);
        setStopStateMessage(t.states.savedOffline);
        setStopStateError('');
        setStopActionDiagnostics({
          phase: 'note-save-queued-offline',
          requestPayload: payload,
          exceptionMessage: err instanceof Error ? err.message : String(err),
          diagnostics: err instanceof CrewApiError ? err.diagnostics : null
        });
        return;
      }

      setStopStateError(t.stop.notesSaveFailed);
      setStopActionDiagnostics({
        phase: 'note-save-failure',
        requestPayload: payload,
        exceptionMessage: err instanceof Error ? err.message : String(err),
        diagnostics: err instanceof CrewApiError ? err.diagnostics : null
      });
    } finally {
      setIsSavingCrewNote(false);
    }
  }

  async function handlePhotoFiles(type: CrewPhotoType, files: FileList | null, stop: Record<string, unknown>) {
    const selectedFiles = Array.from(files || []);
    const cleanRouteAssignmentId = routeAssignmentId(stop);
    const id = stopId(stop);
    if (!selectedFiles.length || !cleanRouteAssignmentId) return;

    setIsUploadingPhoto(type);
    setStopStateMessage('');
    setStopStateError('');
    let objectUrls: string[] = [];
    let previewsAttached = false;

    try {
      objectUrls = selectedFiles.map((file) => URL.createObjectURL(file));
      const base64Images = await Promise.all(selectedFiles.map(fileToDataUrl));
      setPhotoPreviews((current) => {
        const existing = current[id] || { before: [], after: [] };
        const next = {
          ...current,
          [id]: {
            ...existing,
            [type]: [...existing[type], ...objectUrls]
          }
        };
        photoPreviewsRef.current = next;
        return next;
      });
      previewsAttached = true;

      let latestUrl = '';
      const uploadResults = [];
      const returnedUrlFields = [];
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const result = await uploadCrewPhotoApi({
          token,
          route_assignment_id: cleanRouteAssignmentId,
          photo_type: type,
          base64_data: base64Images[index],
          file_name: selectedFiles[index]?.name || `${type}-photo-${index + 1}.jpg`
        });
        uploadResults.push(result);
        const normalizedReturnedUrl = photoUrlFromUploadResult(result, type);
        returnedUrlFields.push({
          photo_url: result.photo_url,
          before_photo_url: result.before_photo_url,
          after_photo_url: result.after_photo_url,
          file_url: result.file_url,
          drive_url: result.drive_url,
          url: result.url,
          normalized_url: normalizedReturnedUrl
        });
        latestUrl = firstString(normalizedReturnedUrl, latestUrl);
      }

      const previousUrl = normalizePhotoUrl(type === 'before' ? stop.before_photo_url : stop.after_photo_url);
      const savedUrl = firstString(latestUrl, previousUrl);
      const photoTimestamp = firstString(
        uploadResults[uploadResults.length - 1]?.timestamp,
        new Date().toISOString()
      );
      const optimisticStop = {
        ...stop,
        [type === 'before' ? 'before_photo_url' : 'after_photo_url']: savedUrl,
        [type === 'before' ? 'before_photo' : 'after_photo']: savedUrl,
        photo_url: firstString(savedUrl, stop.photo_url),
        updated_date: photoTimestamp
      };
      const optimisticBootstrap = updateBootstrapStop(bootstrap, id, optimisticStop);
      if (optimisticBootstrap) cacheAndSetBootstrap(optimisticBootstrap, bootstrap, 'optimistic');
      setSelectedStop(optimisticStop);
      setStopStateMessage(type === 'before' ? t.stop.beforePhotosSaved : t.stop.afterPhotosSaved);
      const photoDiagnostics = {
        phase: 'photo-upload-success',
        requestRouteAssignmentId: cleanRouteAssignmentId,
        photoType: type,
        backendResponseBody: uploadResults,
        uploadCount: selectedFiles.length,
        returnedUrlFields,
        savedPhotoUrl: savedUrl,
        responseData: uploadResults
      };
      setStopActionDiagnostics(photoDiagnostics);
      void refreshStopInBackground(id, optimisticStop, photoDiagnostics);
    } catch (err) {
      if (!previewsAttached) {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
      }
      setStopStateError(t.stop.photoUploadFailed);
      setStopActionDiagnostics({
        phase: 'photo-upload-failure',
        requestRouteAssignmentId: cleanRouteAssignmentId,
        photoType: type,
        uploadCount: selectedFiles.length,
        exceptionMessage: err instanceof Error ? err.message : String(err),
        diagnostics: err instanceof CrewApiError ? err.diagnostics : null
      });
    } finally {
      setIsUploadingPhoto('');
    }
  }

  function handleLogout() {
    clearPhotoPreviews();
    clearCrewToken();
    setToken('');
    setSession(null);
    setBootstrap(null);
    setBootstrapSource('none');
    setLastSyncedAt('');
    setWorkspaceError('');
    setWorkspaceDiagnostics(null);
    setCurrentView('dashboard');
    setSelectedStop(null);
    setDayStateMessage('');
    setDayStateError('');
    setDayStateDiagnostics(null);
    setStopStateMessage('');
    setStopStateError('');
    setStopActionDiagnostics(null);
    setCrewNoteDraft('');
    setEnlargedPhoto(null);
  }

  if (isRestoringSession) {
    return (
      <main className="crew-app-screen">
        <section className="crew-status-card crew-loading-card">
          <p className="crew-kicker">{t.app.crewKicker}</p>
          <h1>{t.states.restoringSession}</h1>
        </section>
      </main>
    );
  }

  if (!token) {
    return <LoginScreen onLogin={handleLogin} t={t} />;
  }

  if (isLoadingWorkspace) {
    return (
      <main className="crew-app-screen">
        <section className="crew-status-card crew-loading-card">
          <p className="crew-kicker">{t.app.crewKicker}</p>
          <h1>{t.states.loadingWorkspace}</h1>
        </section>
      </main>
    );
  }

  if (workspaceError) {
    return (
      <main className="crew-app-screen">
        <section className="crew-status-card crew-loading-card">
          <p className="crew-kicker">{t.app.crewKicker}</p>
          <h1>{workspaceError}</h1>
          <button className="crew-primary-button" onClick={() => void loadWorkspace(token)} type="button">
            {t.actions.retry}
          </button>
          {isDeveloperMode && workspaceDiagnostics ? (
            <details className="crew-diagnostics" open>
              <summary>{t.dashboard.bootstrapDiagnostics}</summary>
              <pre>{JSON.stringify(workspaceDiagnostics, null, 2)}</pre>
            </details>
          ) : null}
          <button className="crew-secondary-button" onClick={handleLogout} type="button">
            {t.actions.logout}
          </button>
        </section>
      </main>
    );
  }

  const routes = getRoutes(bootstrap);
  const stops = getStops(bootstrap);
  const completedStops = getCompletedStops(stops);
  const remainingStops = Math.max(stops.length - completedStops.length, 0);
  const activeStops = stops.filter((stop) => !isCompletedStop(stop));
  const primaryRoute = routes[0];
  const visibleCrewMembers = Array.isArray(bootstrap?.crew) ? bootstrap.crew : [];
  const visibleCrewMember = visibleCrewMembers[0];
  const crewName = firstString(
    bootstrap?.crew?.crew_name,
    bootstrap?.crew?.name,
    visibleCrewMember?.crew_assignment,
    visibleCrewMember?.crew_name,
    primaryRoute?.crew_name,
    primaryRoute?.crew_assignment,
    bootstrap?.session?.crew_name,
    bootstrap?.crew_session?.crew_name,
    bootstrap?.crew_session?.crew_assignment,
    session?.crew_assignment,
    session?.crew_name
  );
  const role = roleLabel(firstString(session?.role, bootstrap?.employee?.role, bootstrap?.session?.role), t);
  const displayCrewName = crewName || t.states.crewAssigned;
  const name = displayName(session, t);
  const now = new Date();
  const daySession = getCurrentDaySession(bootstrap, session);
  const dayStatus = getDayStatus(daySession);
  const lastSyncedLabel = lastSyncedAt ? `${t.states.lastSynced}: ${formatLastSynced(lastSyncedAt, language)}` : '';
  const currentDayDiagnostics = isDeveloperMode
    ? resolveDayStateDiagnostics(bootstrap, session, bootstrapSource, lastSyncedAt)
    : null;
  const syncStatusLabel = isSyncingOfflineQueue ? t.states.syncing : (isOnline ? t.states.online : t.states.offline);
  const syncStrip = (
    <div className={`crew-sync-strip${!isOnline ? ' crew-sync-strip-warning' : ''}`}>
      <span>{syncStatusLabel}</span>
      {pendingQueueCount > 0 ? <span>{t.states.pendingSync(pendingQueueCount)}</span> : null}
      {lastSyncedLabel ? <small>{lastSyncedLabel}</small> : null}
    </div>
  );

  if (currentView === 'stopDetail' && selectedStop) {
    const clientName = stopText(selectedStop, ['client_name', 'client', 'customer_name', 'customer'], t.route.unknownClient);
    const propertyName = stopText(selectedStop, ['property_name', 'property', 'site_name', 'name'], t.route.unknownProperty);
    const propertyAddress = stopText(selectedStop, ['property_address', 'address', 'service_address', 'street_address'], t.route.unknownAddress);
    const serviceType = stopText(selectedStop, ['service_type', 'service', 'work_type', 'job_type'], t.route.unknownService);
    const workOrderName = stopText(selectedStop, ['work_order_name', 'work_order_title', 'work_order', 'job_name', 'job_title', 'title'], t.route.unknownWorkOrder);
    const notes = stopText(selectedStop, ['notes', 'note', 'crew_note', 'service_notes', 'description', 'internal_notes'], t.route.noNotes);
    const scheduledDate = stopScheduledDate(selectedStop, language, t);
    const displayRouteAssignmentId = firstString(selectedStop.assignment_id, selectedStop.route_assignment_id, selectedStop.id);
    const selectedStopStatus = normalizeStopStatusKey(selectedStop);
    const beforePhotoUrls = stopPhotoUrls(selectedStop, 'before');
    const afterPhotoUrls = stopPhotoUrls(selectedStop, 'after');
    const rawBeforePhotoUrls = rawStopPhotoUrlValues(selectedStop, 'before');
    const rawAfterPhotoUrls = rawStopPhotoUrlValues(selectedStop, 'after');
    const filteredBeforePhotoUrls = filteredStopPhotoUrls(selectedStop, 'before');
    const filteredAfterPhotoUrls = filteredStopPhotoUrls(selectedStop, 'after');
    const localPhotos = photoPreviews[stopId(selectedStop)] || { before: [], after: [] };
    const selectedStopRouteAssignmentId = routeAssignmentId(selectedStop);
    const routeListStopMatches = stops.filter((stop) => routeAssignmentId(stop) === selectedStopRouteAssignmentId);
    const currentRouteListStop = routeListStopMatches[0] || null;
    const bootstrapStopMatches = [
      ...arrayFromUnknown(bootstrap?.stops),
      ...arrayFromUnknown(bootstrap?.assignments),
      ...getRoutes(bootstrap).flatMap((route) => [
        ...arrayFromUnknown(route.stops),
        ...arrayFromUnknown(route.assignments),
        ...arrayFromUnknown(route.properties)
      ])
    ].filter((stop) => routeAssignmentId(stop) === selectedStopRouteAssignmentId);
    const stopBootstrapDiagnostics = {
      source: bootstrapSource,
      lastSyncedAt,
      selected_route_assignment_id: selectedStopRouteAssignmentId,
      selectedStop: stopPhotoDiagnostics(selectedStop),
      currentRouteListStop: stopPhotoDiagnostics(currentRouteListStop),
      routeListMatchCount: routeListStopMatches.length,
      routeListMatches: routeListStopMatches.map(stopPhotoDiagnostics),
      bootstrapMatchCount: bootstrapStopMatches.length,
      bootstrapMatches: bootstrapStopMatches.map(stopPhotoDiagnostics),
      photoRendering: {
        before: {
          visiblePhotoCount: 0,
          rawPhotoUrls: rawBeforePhotoUrls,
          filteredPhotoUrls: filteredBeforePhotoUrls
        },
        after: {
          visiblePhotoCount: 0,
          rawPhotoUrls: rawAfterPhotoUrls,
          filteredPhotoUrls: filteredAfterPhotoUrls
        }
      },
      bootstrapTopLevelStopCount: arrayFromUnknown(bootstrap?.stops).length,
      bootstrapRouteCount: getRoutes(bootstrap).length
    };
    const visibleBeforePhotos = [...beforePhotoUrls, ...localPhotos.before];
    const visibleAfterPhotos = [...afterPhotoUrls, ...localPhotos.after];
    stopBootstrapDiagnostics.photoRendering.before.visiblePhotoCount = visibleBeforePhotos.length;
    stopBootstrapDiagnostics.photoRendering.after.visiblePhotoCount = visibleAfterPhotos.length;
    const workStarted = stopTimestamp(
      selectedStop,
      ['work_started_at', 'start_work_time', 'started_at', 'check_in_time', 'in_progress_at'],
      language,
      t
    );
    const workFinished = stopTimestamp(
      selectedStop,
      [
        'work_finished_at',
        'finish_work_time',
        'finished_at',
        'completed_at',
        'completion_time',
        'completed_time',
        'check_out_time'
      ],
      language,
      t
    );

    return (
      <main className="crew-dashboard-screen">
        <section className="crew-dashboard-card">
          {syncStrip}
          <div className="crew-route-topbar">
            <button className="crew-back-button" onClick={() => setCurrentView('route')} type="button">
              {t.route.backToRoute}
            </button>
          </div>

          <div className="crew-status-header">
            <div>
              <p className="crew-kicker">{t.route.clientName}</p>
              <h1>{clientName}</h1>
            </div>
            <span className={`crew-stop-status crew-stop-status-${normalizeStopStatusKey(selectedStop)}`}>
              {stopStatusLabel(selectedStop, t)}
            </span>
          </div>

          <div className="crew-stop-action-panel">
            {selectedStopStatus === 'pending' && (
              <button
                className="crew-primary-button"
                disabled={isSavingStopState}
                onClick={() => void handleStopAction('start_work', selectedStop)}
                type="button"
              >
                {isSavingStopState ? t.stop.savingWork : t.stop.startWork}
              </button>
            )}
            {selectedStopStatus === 'inProgress' && (
              <button
                className="crew-primary-button"
                disabled={isSavingStopState}
                onClick={() => void handleStopAction('finish_work', selectedStop)}
                type="button"
              >
                {isSavingStopState ? t.stop.savingWork : t.stop.finishWork}
              </button>
            )}
            {selectedStopStatus === 'completed' && (
              <button className="crew-secondary-button" disabled type="button">
                {t.stop.completed}
              </button>
            )}
            {stopStateMessage && <p className="crew-success">{stopStateMessage}</p>}
            {stopStateError && <p className="crew-error">{stopStateError}</p>}
          </div>

          <section className="crew-documentation-section" aria-labelledby="before-photos-title">
            <div className="crew-documentation-header">
              <div>
                <p className="crew-section-label" id="before-photos-title">{t.stop.beforePhotos}</p>
                <strong>{t.stop.photoCount(visibleBeforePhotos.length)}</strong>
              </div>
              <label className="crew-photo-upload-button">
                {isUploadingPhoto === 'before' ? t.stop.uploadingPhotos : t.stop.addBeforePhotos}
                <input
                  accept="image/*"
                  capture="environment"
                  multiple
                  onChange={(event) => {
                    void handlePhotoFiles('before', event.currentTarget.files, selectedStop);
                    event.currentTarget.value = '';
                  }}
                  type="file"
                />
              </label>
            </div>
            <div className="crew-photo-grid">
              {visibleBeforePhotos.map((url, index) => (
                <PhotoThumbnail
                  alt={t.stop.beforePhotos}
                  key={`before-${index}-${url}`}
                  onOpen={(photoUrl) => openCrewPhoto(photoUrl, t.stop.beforePhotos)}
                  t={t}
                  url={url}
                />
              ))}
            </div>
          </section>

          <section className="crew-documentation-section" aria-labelledby="crew-notes-title">
            <div className="crew-documentation-header">
              <div>
                <p className="crew-section-label" id="crew-notes-title">{t.stop.crewNotes}</p>
                <strong>{t.stop.notesHint}</strong>
              </div>
            </div>
            <textarea
              className="crew-notes-input"
              onChange={(event) => setCrewNoteDraft(event.target.value)}
              placeholder={t.stop.notesPlaceholder}
              rows={5}
              value={crewNoteDraft}
            />
            <button
              className="crew-secondary-button crew-inline-button"
              disabled={isSavingCrewNote || !crewNoteDraft.trim()}
              onClick={() => void handleSaveCrewNote(selectedStop)}
              type="button"
            >
              {isSavingCrewNote ? t.stop.savingNotes : t.stop.saveNotes}
            </button>
          </section>

          <section className="crew-documentation-section" aria-labelledby="after-photos-title">
            <div className="crew-documentation-header">
              <div>
                <p className="crew-section-label" id="after-photos-title">{t.stop.afterPhotos}</p>
                <strong>{t.stop.photoCount(visibleAfterPhotos.length)}</strong>
              </div>
              <label className="crew-photo-upload-button">
                {isUploadingPhoto === 'after' ? t.stop.uploadingPhotos : t.stop.addAfterPhotos}
                <input
                  accept="image/*"
                  capture="environment"
                  multiple
                  onChange={(event) => {
                    void handlePhotoFiles('after', event.currentTarget.files, selectedStop);
                    event.currentTarget.value = '';
                  }}
                  type="file"
                />
              </label>
            </div>
            <div className="crew-photo-grid">
              {visibleAfterPhotos.map((url, index) => (
                <PhotoThumbnail
                  alt={t.stop.afterPhotos}
                  key={`after-${index}-${url}`}
                  onOpen={(photoUrl) => openCrewPhoto(photoUrl, t.stop.afterPhotos)}
                  t={t}
                  url={url}
                />
              ))}
            </div>
          </section>

          <dl className="crew-stop-detail-list">
            <div>
              <dt>{t.route.propertyName}</dt>
              <dd>{propertyName}</dd>
            </div>
            <div>
              <dt>{t.route.propertyAddress}</dt>
              <dd>{propertyAddress}</dd>
            </div>
            <div>
              <dt>{t.route.serviceType}</dt>
              <dd>{serviceType}</dd>
            </div>
            <div>
              <dt>{t.route.workOrderName}</dt>
              <dd>{workOrderName}</dd>
            </div>
            <div>
              <dt>{t.route.status}</dt>
              <dd>{stopStatusLabel(selectedStop, t)}</dd>
            </div>
            <div>
              <dt>{t.route.notes}</dt>
              <dd>{notes}</dd>
            </div>
            <div>
              <dt>{t.route.scheduledDate}</dt>
              <dd>{scheduledDate}</dd>
            </div>
            <div>
              <dt>{t.stop.workStarted}</dt>
              <dd>{workStarted}</dd>
            </div>
            <div>
              <dt>{t.stop.workFinished}</dt>
              <dd>{workFinished}</dd>
            </div>
          </dl>

          {isDeveloperMode ? (
          <details className="crew-diagnostics">
            <summary>{t.dashboard.debugDetails}</summary>
            <pre>{JSON.stringify(stopBootstrapDiagnostics, null, 2)}</pre>
          </details>
          ) : null}

          {isDeveloperMode && stopActionDiagnostics ? (
            <details className="crew-diagnostics">
              <summary>{t.stop.actionDiagnostics}</summary>
              <pre>{JSON.stringify(stopActionDiagnostics, null, 2)}</pre>
            </details>
          ) : null}

          {enlargedPhoto ? (
            <EnlargedPhotoModal
              label={enlargedPhoto.label}
              onClose={() => setEnlargedPhoto(null)}
              t={t}
              url={enlargedPhoto.url}
            />
          ) : null}
        </section>
      </main>
    );
  }

  if (currentView === 'route') {
    const renderStopCard = (stop: Record<string, unknown>, index: number, section: 'active' | 'completed') => (
      <button
        className="crew-stop-card crew-stop-card-button"
        key={`${section}-${firstString(stop.assignment_id, stop.route_assignment_id, stop.id, index)}`}
        onClick={() => {
          setSelectedStop(stop);
          setCrewNoteDraft(stopText(stop, ['crew_note', 'notes', 'note', 'service_notes'], ''));
          setCurrentView('stopDetail');
          setStopStateMessage('');
          setStopStateError('');
        }}
        type="button"
      >
        <div className="crew-stop-card-header">
          <div>
            <p className="crew-section-label">{t.route.clientName}</p>
            <h2>{stopText(stop, ['client_name', 'client', 'customer_name', 'customer'], t.route.unknownClient)}</h2>
          </div>
          <span className={`crew-stop-status crew-stop-status-${normalizeStopStatusKey(stop)}`}>
            {stopStatusLabel(stop, t)}
          </span>
        </div>

        <dl className="crew-stop-details">
          <div>
            <dt>{t.route.propertyName}</dt>
            <dd>{stopText(stop, ['property_name', 'property', 'site_name', 'name'], t.route.unknownProperty)}</dd>
          </div>
          <div>
            <dt>{t.route.propertyAddress}</dt>
            <dd>{stopText(stop, ['property_address', 'address', 'service_address', 'street_address'], t.route.unknownAddress)}</dd>
          </div>
          <div>
            <dt>{t.route.serviceType}</dt>
            <dd>{stopText(stop, ['service_type', 'service', 'work_type', 'job_type'], t.route.unknownService)}</dd>
          </div>
          <div>
            <dt>{t.route.status}</dt>
            <dd>{stopStatusLabel(stop, t)}</dd>
          </div>
        </dl>
      </button>
    );

    return (
      <main className="crew-dashboard-screen">
        <section className="crew-dashboard-card">
          {syncStrip}
          <div className="crew-route-topbar">
            <button className="crew-back-button" onClick={() => setCurrentView('dashboard')} type="button">
              {t.route.backToDashboard}
            </button>
          </div>

          <div className="crew-status-header">
            <div>
              <p className="crew-kicker">{formatCrewDate(now, language)}</p>
              <h1>{t.dashboard.todaysRoute}</h1>
            </div>
            <span className="crew-status-badge">{routeTitle(primaryRoute, t)}</span>
          </div>

          <div className="crew-metric-grid crew-route-metric-grid">
            <div>
              <span>{t.route.assignedStops}</span>
              <strong>{stops.length}</strong>
            </div>
            <div>
              <span>{t.route.completedStops}</span>
              <strong>{completedStops.length}</strong>
            </div>
            <div>
              <span>{t.route.remainingStops}</span>
              <strong>{remainingStops}</strong>
            </div>
          </div>

          {stops.length ? (
            <>
              <section className="crew-stop-section" aria-labelledby="active-stops-title">
                <div className="crew-stop-section-header">
                  <p className="crew-section-label" id="active-stops-title">{t.route.activeStops}</p>
                  <strong>{activeStops.length}</strong>
                </div>
                {activeStops.length ? (
                  <div className="crew-stop-list">
                    {activeStops.map((stop, index) => renderStopCard(stop, index, 'active'))}
                  </div>
                ) : (
                  <div className="crew-empty-route">{t.route.allActiveStopsCompleted}</div>
                )}
              </section>

              <section className="crew-stop-section" aria-labelledby="completed-stops-title">
                <div className="crew-stop-section-header">
                  <p className="crew-section-label" id="completed-stops-title">{t.route.completedStops}</p>
                  <strong>{completedStops.length}</strong>
                </div>
                {completedStops.length ? (
                  <div className="crew-stop-list">
                    {completedStops.map((stop, index) => renderStopCard(stop, index, 'completed'))}
                  </div>
                ) : null}
              </section>
            </>
          ) : (
            <div className="crew-empty-route">{t.states.noRouteAssigned}</div>
          )}

          {isDeveloperMode ? (
          <details className="crew-diagnostics">
            <summary>{t.dashboard.debugDetails}</summary>
            <pre>{JSON.stringify({ session, bootstrap }, null, 2)}</pre>
          </details>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="crew-dashboard-screen">
      <section className="crew-dashboard-card">
        {syncStrip}
        <div className="crew-status-header">
          <div>
            <p className="crew-kicker">{formatCrewDate(now, language)}</p>
            <h1>{greetingForDate(now, language)}, {name}</h1>
          </div>
          <span className="crew-status-badge">{role}</span>
        </div>

        {(isSyncing || (isDeveloperMode && cacheWarning)) && (
          <div className={`crew-sync-strip${cacheWarning ? ' crew-sync-strip-warning' : ''}`}>
            {isSyncing && <span>{t.states.syncing}</span>}
            {isDeveloperMode && cacheWarning && <span>{cacheWarning}</span>}
          </div>
        )}

        <div className="crew-ready-card">
          <p>{t.states.readyForRoute}</p>
          <strong>{displayCrewName}</strong>
        </div>

        <dl className="crew-profile-list">
          <div>
            <dt>{t.dashboard.employeeName}</dt>
            <dd>{name}</dd>
          </div>
          <div>
            <dt>{t.dashboard.role}</dt>
            <dd>{role}</dd>
          </div>
          <div>
            <dt>{t.dashboard.crewName}</dt>
            <dd>{displayCrewName}</dd>
          </div>
        </dl>

        <section className="crew-day-card" aria-labelledby="crew-day-status-title">
          <div className="crew-day-card-header">
            <div>
              <p className="crew-section-label" id="crew-day-status-title">{t.day.todayStatus}</p>
              <h2>{dayStatusLabel(dayStatus, t)}</h2>
            </div>
            <span className={`crew-day-status crew-day-status-${dayStatus}`}>
              {dayStatusLabel(dayStatus, t)}
            </span>
          </div>

          <dl className="crew-day-times">
            <div>
              <dt>{t.day.clockInTime}</dt>
              <dd>{formatCrewTime(daySession?.clock_in_time, language, t)}</dd>
            </div>
            <div>
              <dt>{t.day.lunchStatus}</dt>
              <dd>
                {daySession?.lunch_start_time
                  ? `${t.day.lunchStart}: ${formatCrewTime(daySession.lunch_start_time, language, t)}`
                  : t.day.noLunchTaken}
                {daySession?.lunch_end_time
                  ? ` / ${t.day.lunchEnd}: ${formatCrewTime(daySession.lunch_end_time, language, t)}`
                  : ''}
              </dd>
            </div>
            <div>
              <dt>{t.day.clockOutTime}</dt>
              <dd>{formatCrewTime(daySession?.clock_out_time, language, t)}</dd>
            </div>
          </dl>

          {dayStateMessage ? <div className="crew-action-success">{dayStateMessage}</div> : null}
          {dayStateError ? <div className="crew-error">{dayStateError}</div> : null}
          {isDeveloperMode && dayStateDiagnostics ? (
            <details className="crew-diagnostics">
              <summary>{t.day.actionDiagnostics}</summary>
              <pre>{JSON.stringify(dayStateDiagnostics, null, 2)}</pre>
            </details>
          ) : null}
          {isDeveloperMode && currentDayDiagnostics ? (
            <details className="crew-diagnostics">
              <summary>{t.day.currentDayDiagnostics}</summary>
              <pre>{JSON.stringify(currentDayDiagnostics, null, 2)}</pre>
            </details>
          ) : null}

          <div className="crew-day-actions">
            {dayStatus === 'not_started' ? (
              <button className="crew-primary-button" disabled={isSavingDayState} onClick={() => void handleDayAction('clock_in')} type="button">
                {t.day.startDay}
              </button>
            ) : null}

            {dayStatus === 'working' ? (
              <>
                <button className="crew-primary-button" disabled={isSavingDayState} onClick={() => void handleDayAction('lunch_start')} type="button">
                  {t.day.lunch}
                </button>
                <button className="crew-secondary-button crew-day-secondary-button" disabled={isSavingDayState} onClick={() => void handleDayAction('clock_out')} type="button">
                  {t.day.clockOut}
                </button>
              </>
            ) : null}

            {dayStatus === 'on_lunch' ? (
              <>
                <button className="crew-primary-button" disabled={isSavingDayState} onClick={() => void handleDayAction('lunch_end')} type="button">
                  {t.day.resume}
                </button>
                <button className="crew-secondary-button crew-day-secondary-button" disabled={isSavingDayState} onClick={() => void handleDayAction('clock_out')} type="button">
                  {t.day.clockOut}
                </button>
              </>
            ) : null}

            {dayStatus === 'clocked_out' ? (
              <>
                <div className="crew-day-completed">{t.day.dayCompleted}</div>
                <button
                  className="crew-primary-button"
                  disabled={isSavingDayState}
                  onClick={() => void handleDayAction('reopen_day')}
                  type="button"
                >
                  {t.day.resumeDay}
                </button>
              </>
            ) : null}
          </div>
        </section>

        <div className="crew-metric-grid">
          <div>
            <span>{t.dashboard.routesToday}</span>
            <strong>{routes.length}</strong>
          </div>
          <div>
            <span>{t.dashboard.stopsToday}</span>
            <strong>{stops.length}</strong>
          </div>
        </div>

        <section className="crew-route-summary" aria-labelledby="crew-route-summary-title">
          <p className="crew-section-label" id="crew-route-summary-title">{t.dashboard.todaysRoute}</p>
          {routes.length ? (
            <div className="crew-route-card">
              <h2>{routeTitle(primaryRoute, t)}</h2>
              <p>{stops.length ? t.dashboard.assignedStops(stops.length) : t.states.stopsNotListed}</p>
            </div>
          ) : (
            <div className="crew-empty-route">{t.states.noRouteAssigned}</div>
          )}
        </section>

        <button
          className="crew-primary-button"
          onClick={() => {
            setSelectedStop(null);
            setCurrentView('route');
          }}
          type="button"
        >
          {t.route.viewRoute}
        </button>

        {isDeveloperMode ? (
        <details className="crew-diagnostics">
          <summary>{t.dashboard.debugDetails}</summary>
          <pre>{JSON.stringify({ session, bootstrap }, null, 2)}</pre>
        </details>
        ) : null}

        <button className="crew-secondary-button" onClick={handleLogout} type="button">
          {t.actions.logout}
        </button>
      </section>
    </main>
  );
}
