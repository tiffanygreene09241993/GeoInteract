import { auth } from '../firebase/client';

/**
 * Wraps browser fetch to automatically attach the signed-in Firebase user's
 * ID token as an Authorization Bearer header for protected server API routes.
 */
export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  try {
    const currentUser = auth.currentUser;
    if (currentUser) {
      const token = await currentUser.getIdToken();
      if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    }
  } catch {
    // Proceed without Authorization header if offline or token unavailable
  }

  return fetch(input, {
    ...init,
    headers,
  });
}
