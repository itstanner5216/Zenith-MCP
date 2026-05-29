import { createClient, type User } from '@workos-inc/authkit-js';

// Get client ID from Vite env
const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID;

if (!clientId) {
  throw new Error(
    'VITE_WORKOS_CLIENT_ID is not set. Add it to your .env.local file.',
  );
}

// AuthKit client instance (initialized asynchronously)
let authkit: Awaited<ReturnType<typeof createClient>> | null = null;

// Callbacks for auth state changes
type AuthStateListener = (user: User | null) => void;
const listeners: Set<AuthStateListener> = new Set();

/**
 * Initialize the AuthKit client.
 * Must be called before using any auth functions.
 */
export async function initAuth(): Promise<void> {
  authkit = await createClient(clientId, {
    redirectUri: window.location.origin + '/callback',
    onRedirectCallback: () => {
      // Clear URL params after successful auth
      window.history.replaceState({}, '', '/');
      notifyListeners();
    },
    onRefresh: () => {
      notifyListeners();
    },
    onRefreshFailure: () => {
      // Log refresh failure - user will need to sign in again
      console.warn('Session refresh failed');
      notifyListeners();
    },
  });
  notifyListeners();
}

/**
 * Get the current authenticated user, or null if not signed in.
 */
export function getUser(): User | null {
  return authkit?.getUser() ?? null;
}

/**
 * Redirect to WorkOS sign-in page.
 * Must be called from a user gesture (click handler).
 */
export async function signIn(): Promise<void> {
  if (!authkit) {
    throw new Error('Auth not initialized. Call initAuth() first.');
  }
  await authkit.signIn();
}

/**
 * Redirect to WorkOS sign-up page.
 * Must be called from a user gesture (click handler).
 */
export async function signUp(): Promise<void> {
  if (!authkit) {
    throw new Error('Auth not initialized. Call initAuth() first.');
  }
  await authkit.signUp();
}

/**
 * Sign out the current user.
 */
export function signOut(): void {
  if (!authkit) {
    throw new Error('Auth not initialized. Call initAuth() first.');
  }
  authkit.signOut();
}

/**
 * Get access token for API calls.
 */
export async function getAccessToken(): Promise<string> {
  if (!authkit) {
    throw new Error('Auth not initialized. Call initAuth() first.');
  }
  return authkit.getAccessToken();
}

/**
 * Subscribe to auth state changes.
 */
export function onAuthStateChange(listener: AuthStateListener): () => void {
  listeners.add(listener);
  // Immediately call with current state
  listener(getUser());
  // Return unsubscribe function
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  const user = getUser();
  listeners.forEach((listener) => listener(user));
}
