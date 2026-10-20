import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { IntelligenceDashboard } from '@/components/bow-era-intelligence-dashboard';
import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { readSessionCookie } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function IntelligencePage() {
  const cookieStore = await cookies();
  const cookieHeader = (await headers()).get('cookie') ?? cookieStore.toString();
  const sessionId = readSessionCookie(cookieHeader);
  const session = sessionId
    ? await getAuthSessionManagers().authenticated.retrieve(sessionId)
    : null;
  const expiresAt = Number(session?.data.accessTokenExpiresAt);

  if (
    !session ||
    !session.data.accessToken ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    redirect('/api/auth/login?returnTo=%2Fintelligence');
  }

  return <IntelligenceDashboard />;
}
