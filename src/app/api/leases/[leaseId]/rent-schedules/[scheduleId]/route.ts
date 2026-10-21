import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createLeaseHandlers } from '@/lib/auth/lease-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ leaseId: string; scheduleId: string }> },
): Promise<Response> {
  const { leaseId, scheduleId } = await context.params;
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).updateRentSchedule(request, leaseId, scheduleId);
}
