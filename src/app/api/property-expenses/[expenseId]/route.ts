import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createLeaseHandlers } from '@/lib/auth/lease-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ expenseId: string }> },
): Promise<Response> {
  const { expenseId } = await context.params;
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).getPropertyExpense(request, expenseId);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ expenseId: string }> },
): Promise<Response> {
  const { expenseId } = await context.params;
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).updatePropertyExpense(request, expenseId);
}
