import { en } from './en';
import { es } from './es';

export type SupportedLanguage = 'en' | 'es';
export type Translations = {
  app: {
    productName: string;
    brandName: string;
    shortName: string;
    crewKicker: string;
  };
  auth: {
    instructions: string;
    emailLabel: string;
    emailPlaceholder: string;
    pinLabel: string;
    pinPlaceholder: string;
    signIn: string;
    signingIn: string;
    temporaryDiagnostics: string;
  };
  states: {
    restoringSession: string;
    loadingWorkspace: string;
    readyForRoute: string;
    noRouteAssigned: string;
    unableToLoadWorkspace: string;
    crewAssigned: string;
    crewAssignmentPending: string;
    stopsNotListed: string;
    syncing: string;
    online: string;
    offline: string;
    pendingSync: (count: number) => string;
    savedOffline: string;
    usingLastSavedData: string;
    lastSynced: string;
  };
  day: {
    todayStatus: string;
    notStarted: string;
    working: string;
    onLunch: string;
    clockedOut: string;
    dayCompleted: string;
    clockInTime: string;
    lunchStatus: string;
    lunchStart: string;
    lunchEnd: string;
    clockOutTime: string;
    startDay: string;
    resumeDay: string;
    clockInAgain: string;
    lunch: string;
    resume: string;
    resumeWork: string;
    clockOut: string;
    notAvailable: string;
    noLunchTaken: string;
    startDaySuccess: string;
    lunchStarted: string;
    backFromLunch: string;
    clockOutSuccess: string;
    dayReopened: string;
    reopenDayFailed: string;
    updateFailed: string;
    actionDiagnostics: string;
    currentDayDiagnostics: string;
  };
  dashboard: {
    routes: string;
    stops: string;
    routesToday: string;
    stopsToday: string;
    todaysRoute: string;
    employeeName: string;
    crewName: string;
    role: string;
    debugDetails: string;
    bootstrapDiagnostics: string;
    routeFallback: string;
    roleCrew: string;
    roleCrewLeader: string;
    roleCrewMember: string;
    roleAdmin: string;
    assignedStops: (count: number) => string;
  };
  route: {
    viewRoute: string;
    backToDashboard: string;
    backToRoute: string;
    assignedStops: string;
    activeStops: string;
    completedStops: string;
    remainingStops: string;
    allActiveStopsCompleted: string;
    clientName: string;
    propertyName: string;
    propertyAddress: string;
    serviceType: string;
    workOrderName: string;
    status: string;
    notes: string;
    scheduledDate: string;
    unknownClient: string;
    unknownProperty: string;
    unknownAddress: string;
    unknownService: string;
    unknownWorkOrder: string;
    noNotes: string;
    noScheduledDate: string;
  };
  status: {
    pending: string;
    inProgress: string;
    completed: string;
  };
  stop: {
    startWork: string;
    finishWork: string;
    completed: string;
    savingWork: string;
    workStarted: string;
    workFinished: string;
    startWorkSuccess: string;
    finishWorkSuccess: string;
    updateFailed: string;
    mustBeClockedIn: string;
    mustResumeWork: string;
    actionDiagnostics: string;
    beforePhotos: string;
    afterPhotos: string;
    addBeforePhotos: string;
    addAfterPhotos: string;
    uploadingPhotos: string;
    beforePhotosSaved: string;
    afterPhotosSaved: string;
    photoUploadFailed: string;
    photoUnavailable: string;
    photoSaved: string;
    viewPhoto: string;
    closePhoto: string;
    crewNotes: string;
    notesHint: string;
    notesPlaceholder: string;
    saveNotes: string;
    savingNotes: string;
    notesSaved: string;
    notesSaveFailed: string;
    photoCount: (count: number) => string;
  };
  actions: {
    retry: string;
    logout: string;
  };
  errors: {
    unableToLogin: string;
    missingCrewToken: string;
    sessionInvalid: string;
  };
  greetings: {
    morning: string;
    afternoon: string;
    evening: string;
  };
  fallback: {
    crewMember: string;
  };
};

const dictionaries: Record<SupportedLanguage, Translations> = {
  en,
  es
};

export function normalizeLanguage(value: unknown): SupportedLanguage | '' {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return '';

  if (clean === 'en' || clean === 'english') return 'en';
  if (clean === 'es' || clean === 'spanish' || clean === 'español' || clean === 'espanol') return 'es';
  if (clean.startsWith('en-')) return 'en';
  if (clean.startsWith('es-')) return 'es';

  return '';
}

export function resolveLanguage(...values: unknown[]): SupportedLanguage {
  for (const value of values) {
    const language = normalizeLanguage(value);
    if (language) return language;
  }

  return 'en';
}

export function browserLanguage(): SupportedLanguage {
  if (typeof navigator === 'undefined') return 'en';
  return resolveLanguage(navigator.language, ...(navigator.languages || []));
}

export function getTranslations(language: SupportedLanguage): Translations {
  return dictionaries[language] || dictionaries.en;
}

export function localeForLanguage(language: SupportedLanguage): string {
  return language === 'es' ? 'es-US' : 'en-US';
}

export function formatCrewDate(date: Date, language: SupportedLanguage): string {
  return new Intl.DateTimeFormat(localeForLanguage(language), {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
}

export function greetingKey(date: Date): keyof Translations['greetings'] {
  const hour = date.getHours();

  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  return 'evening';
}

export function greetingForDate(date: Date, language: SupportedLanguage): string {
  const t = getTranslations(language);
  return t.greetings[greetingKey(date)];
}
