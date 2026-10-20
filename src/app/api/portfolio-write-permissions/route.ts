import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createPortfolioHandlers } from '@/lib/auth/portfolio-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return createPortfolioHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).getPortfolioWritePermissions(request);
}
