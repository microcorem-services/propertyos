import { createProductionCognitoAuthHandlers } from '@/lib/auth/cognito-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return createProductionCognitoAuthHandlers().callback(request);
}
