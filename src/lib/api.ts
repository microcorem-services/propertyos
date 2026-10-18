export type PropertyStatus = 'Operational' | 'Review' | 'Maintenance';

export type Property = {
  id: string;
  name: string;
  location: string;
  units: number;
  occupied: number;
  status: PropertyStatus;
};

export type PropertyInput = Omit<Property, 'id'>;

export type DashboardStats = {
  properties: number;
  total_units: number;
  occupied_units: number;
  occupancy_percent: number;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    const message = Array.isArray(detail)
      ? detail.map((issue: { msg: string }) => issue.msg).join(' ')
      : typeof detail === 'string'
        ? detail
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const propertyApi = {
  list: () => request<Property[]>('/properties'),
  get: (id: string) => request<Property>(`/properties/${id}`),
  create: (property: PropertyInput) =>
    request<Property>('/properties', {
      method: 'POST',
      body: JSON.stringify(property),
    }),
  update: (id: string, property: PropertyInput) =>
    request<Property>(`/properties/${id}`, {
      method: 'PUT',
      body: JSON.stringify(property),
    }),
  delete: (id: string) => request<void>(`/properties/${id}`, { method: 'DELETE' }),
  stats: () => request<DashboardStats>('/dashboard/stats'),
};