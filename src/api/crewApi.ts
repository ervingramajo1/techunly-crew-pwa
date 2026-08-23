import type {
  CrewApiResponse,
  CrewBootstrapData,
  CrewBootstrapRequest,
  CrewDayStateData,
  CrewDayStateRequest,
  CrewLoginData,
  CrewLoginRequest,
  CrewPhotoUploadData,
  CrewPhotoUploadRequest,
  CrewStopStateData,
  CrewStopStateRequest,
  CrewValidateSessionData,
  CrewValidateSessionRequest
} from './apiTypes';

const crewApiBaseUrl = String(import.meta.env.VITE_CREW_API_BASE_URL || '/api/crew').trim();

export class CrewApiError extends Error {
  diagnostics: Record<string, unknown>;

  constructor(message: string, diagnostics: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CrewApiError';
    this.diagnostics = diagnostics;
  }
}

function buildCrewApiUrl(action: string): string {
  if (!crewApiBaseUrl) {
    throw new CrewApiError('Missing VITE_CREW_API_BASE_URL', {
      phase: 'config',
      action
    });
  }

  try {
    const base = crewApiBaseUrl.replace(/\/$/, '');
    const url = new URL(`${base}/${action}`, window.location.origin);
    return url.toString();
  } catch (err) {
    throw new CrewApiError('Invalid VITE_CREW_API_BASE_URL', {
      phase: 'url-build',
      action,
      crewApiBaseUrl,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function postCrewApi<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const url = buildCrewApiUrl(action);
  const diagnostics: Record<string, unknown> = {
    phase: 'fetch',
    action,
    method: 'POST',
    url,
    origin: window.location.origin,
    requestPayload: payload
  };

  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new CrewApiError('Fetch failed before a response was available.', {
      ...diagnostics,
      likelyCause: 'Browser blocked the request, network failed, or Apps Script did not provide CORS-readable response.',
      fetchErrorName: err instanceof Error ? err.name : '',
      fetchErrorMessage: err instanceof Error ? err.message : String(err)
    });
  }

  diagnostics.httpStatus = response.status;
  diagnostics.httpStatusText = response.statusText;
  diagnostics.responseOk = response.ok;
  diagnostics.responseType = response.type;
  diagnostics.responseUrl = response.url;
  diagnostics.responseHeaders = headersToObject(response.headers);

  const responseBody = await response.text();
  diagnostics.responseBody = responseBody;

  let json: CrewApiResponse<T>;

  try {
    json = JSON.parse(responseBody) as CrewApiResponse<T>;
  } catch (err) {
    throw new CrewApiError('Crew API returned a non-JSON response.', {
      ...diagnostics,
      parseError: err instanceof Error ? err.message : String(err)
    });
  }

  if (!response.ok) {
    throw new CrewApiError(`Crew API request failed with status ${response.status}.`, diagnostics);
  }

  if (!json.ok) {
    throw new CrewApiError(json.error || 'Crew API request failed.', diagnostics);
  }

  if (json.data === undefined || json.data === null) {
    throw new CrewApiError('Crew API response is missing data.', {
      ...diagnostics,
      parsedResponse: json
    });
  }

  return json.data;
}

export function loginCrewApi(payload: CrewLoginRequest): Promise<CrewLoginData> {
  return postCrewApi<CrewLoginData>('login', payload);
}

export function validateCrewSessionApi(
  payload: CrewValidateSessionRequest
): Promise<CrewValidateSessionData> {
  return postCrewApi<CrewValidateSessionData>('validate-session', payload);
}

export function getCrewBootstrapApi(payload: CrewBootstrapRequest): Promise<CrewBootstrapData> {
  return postCrewApi<CrewBootstrapData>('bootstrap', payload);
}

export function saveCrewDayStateApi(payload: CrewDayStateRequest): Promise<CrewDayStateData> {
  return postCrewApi<CrewDayStateData>('day-state', payload);
}

export function saveCrewStopStateApi(payload: CrewStopStateRequest): Promise<CrewStopStateData> {
  return postCrewApi<CrewStopStateData>('stop-action', payload);
}

export function uploadCrewPhotoApi(payload: CrewPhotoUploadRequest): Promise<CrewPhotoUploadData> {
  return postCrewApi<CrewPhotoUploadData>('photo', payload);
}

export function resolveCrewToken(data: CrewLoginData): string {
  return String(data?.token || data?.session_token || data?.crew_token || '').trim();
}

export function isCrewSessionValid(data: CrewValidateSessionData): boolean {
  return data?.success !== false && data?.valid !== false && data?.authenticated !== false;
}

export function resolveValidatedCrewSession(
  data: CrewValidateSessionData,
  token: string
): CrewLoginData {
  const identity = data.employee || data.session || data;

  return {
    ...identity,
    token
  };
}

function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}
