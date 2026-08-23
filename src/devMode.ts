export function isCrewDeveloperMode(): boolean {
  if (typeof window === 'undefined') return false;

  const params = new URLSearchParams(window.location.search);
  const queryFlag = params.get('debug') || params.get('dev') || '';
  if (['1', 'true', 'yes', 'on'].includes(queryFlag.trim().toLowerCase())) return true;

  try {
    return ['1', 'true', 'yes', 'on'].includes(
      String(window.localStorage.getItem('techunly_crew_debug') || '').trim().toLowerCase()
    );
  } catch {
    return false;
  }
}
