import { createClient, type User } from '@workos-inc/authkit-js';

// The Client type is inferred from createClient return type
type AuthKitClient = Awaited<ReturnType<typeof createClient>>;

let authkit: AuthKitClient | null = null;

/**
 * Initialize the AuthKit client.
 * Must be called before any auth operations.
 */
export async function initAuthKit(): Promise<AuthKitClient> {
  const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID;

  if (!clientId) {
    throw new Error('VITE_WORKOS_CLIENT_ID is not defined');
  }

  if (!authkit) {
    authkit = await createClient(clientId);
  }

  return authkit;
}

/**
 * Get the current authenticated user, or null if not authenticated.
 */
export function getUser(): User | null {
  if (!authkit) {
    console.warn('AuthKit not initialized. Call initAuthKit() first.');
    return null;
  }
  return authkit.getUser();
}

/**
 * Trigger the sign-in flow.
 * This opens the WorkOS hosted auth page.
 */
export async function signIn(): Promise<void> {
  if (!authkit) {
    throw new Error('AuthKit not initialized. Call initAuthKit() first.');
  }
  await authkit.signIn();
}

/**
 * Sign out the current user.
 */
export async function signOut(): Promise<void> {
  if (!authkit) {
    throw new Error('AuthKit not initialized. Call initAuthKit() first.');
  }
  await authkit.signOut();
}

/**
 * Get the AuthKit client instance.
 */
export function getAuthKit(): AuthKitClient | null {
  return authkit;
}
