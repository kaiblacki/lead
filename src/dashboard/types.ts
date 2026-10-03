import type http from 'node:http';
import type { Context } from '../context.ts';
import type { Safe } from './html.ts';
import type { Flash, NavKey } from './ui.ts';
import type { SessionUser } from '../team/rules.ts';

export class UserError extends Error {}
export type AppInfo = { baseUrl: string; csrf: string; mock: boolean; autoDeploy: boolean };
export type Req = { ctx: Context; app: AppInfo; req: http.IncomingMessage; res: http.ServerResponse; url: URL; params: string[]; form: URLSearchParams; rawBody: string; killSwitch: boolean; flash: Flash; ip: string; user: SessionUser };
export type Res = { status?: number; body?: Safe | string; redirect?: string; flash?: Flash; type?: string; headers?: Record<string, string> };
export type Route = { method: 'GET' | 'POST'; path: RegExp; public?: boolean; maxBody?: number; h: (r: Req) => Promise<Res> };
export type PageOpts = { title: string; nav: NavKey; body: Safe; status?: number; crumbs?: [string, string?][]; back?: [string, string] };
