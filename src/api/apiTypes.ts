export type CrewApiResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
    };

export type CrewLoginRequest = {
  email: string;
  pin: string;
};

export type CrewIdentity = {
  employee_id?: string;
  employee_name?: string;
  name?: string;
  preferred_name?: string;
  email?: string;
  crew_id?: string;
  crew_name?: string;
  role?: string;
  permissions?: string[] | Record<string, boolean>;
  token?: string;
  session_token?: string;
  crew_token?: string;
  [key: string]: unknown;
};

export type CrewLoginData = CrewIdentity & {
  token?: string;
  session_token?: string;
  crew_token?: string;
};

export type CrewValidateSessionRequest = {
  token: string;
};

export type CrewValidateSessionData = CrewIdentity & {
  success?: boolean;
  valid?: boolean;
  authenticated?: boolean;
  session?: CrewIdentity;
  employee?: CrewIdentity;
};

export type CrewBootstrapRequest = {
  token: string;
  allow_past_route?: boolean;
};

export type CrewBootstrapData = {
  employee?: CrewIdentity;
  session?: CrewIdentity;
  crew?: {
    crew_id?: string;
    crew_name?: string;
    name?: string;
    [key: string]: unknown;
  };
  route?: Record<string, unknown>;
  routes?: Record<string, unknown>[];
  assigned_routes?: Record<string, unknown>[];
  stops?: Record<string, unknown>[];
  assignments?: Record<string, unknown>[];
  sessions?: Record<string, unknown>[];
  crew_session?: CrewIdentity;
  [key: string]: unknown;
};

export type CrewDayStateAction = 'clock_in' | 'lunch_start' | 'lunch_end' | 'clock_out' | 'reopen_day';

export type CrewDayStateRequest = {
  token: string;
  action: CrewDayStateAction;
  route_date?: string;
  session_date?: string;
  local_date_key?: string;
  timestamp?: string;
};

export type CrewDayStateData = {
  success?: boolean;
  message?: string;
  action?: CrewDayStateAction;
  timestamp?: string;
  status?: string;
  [key: string]: unknown;
};

export type CrewStopStateAction = 'check_in' | 'complete_stop' | 'add_note';

export type CrewStopStateRequest = {
  token: string;
  action: CrewStopStateAction;
  timestamp: string;
  stop_id?: string;
  assignment_id?: string;
  route_assignment_id?: string;
  service_id?: string;
  work_order_id?: string;
  crew_id?: string;
  route_date?: string;
  route_day?: string;
  crew_note?: string;
};

export type CrewStopStateData = {
  success?: boolean;
  message?: string;
  action?: CrewStopStateAction;
  timestamp?: string;
  status?: string;
  [key: string]: unknown;
};

export type CrewPhotoType = 'before' | 'after';

export type CrewPhotoUploadRequest = {
  token: string;
  route_assignment_id: string;
  photo_type: CrewPhotoType;
  base64_data: string;
  file_name: string;
};

export type CrewPhotoUploadData = {
  success?: boolean;
  message?: string;
  route_assignment_id?: string;
  photo_type?: CrewPhotoType;
  photo_url?: string;
  drive_file_id?: string;
  timestamp?: string;
  [key: string]: unknown;
};
