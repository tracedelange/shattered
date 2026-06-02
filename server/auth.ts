/**
 * Firebase Admin SDK initialisation + token verification.
 *
 * Credential priority (first match wins):
 *   1. FIREBASE_SERVICE_ACCOUNT   — JSON string of the service-account key
 *   2. FIREBASE_SERVICE_ACCOUNT_PATH — path to the service-account JSON file
 *   3. GOOGLE_APPLICATION_CREDENTIALS / ADC — works automatically on GCP/Firebase Hosting
 *
 * To get a service-account key: Firebase console → Project Settings →
 * Service accounts → Generate new private key.
 */

import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'node:fs';

let _app: App;

function getAdminApp(): App {
  if (_app) return _app;

  // Reuse if already initialised (e.g. hot-reload in dev)
  if (getApps().length > 0) {
    _app = getApps()[0]!;
    return _app;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    _app = initializeApp({ credential: cert(sa) });
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
    _app = initializeApp({ credential: cert(sa) });
  } else {
    // Falls back to GOOGLE_APPLICATION_CREDENTIALS env var or Application Default Credentials.
    // This works automatically when deployed to GCP / Firebase Hosting.
    console.warn(
      '[auth] No FIREBASE_SERVICE_ACCOUNT env var set — ' +
      'falling back to GOOGLE_APPLICATION_CREDENTIALS / ADC.',
    );
    _app = initializeApp();
  }

  return _app;
}

export interface FirebaseIdentity {
  uid: string;
  email: string | null;
}

/**
 * Verifies a Firebase ID token (sent from the client after sign-in) and
 * returns the account's uid and email.  Throws if the token is invalid or
 * expired.
 */
export async function verifyFirebaseToken(token: string): Promise<FirebaseIdentity> {
  const auth = getAuth(getAdminApp());
  const decoded = await auth.verifyIdToken(token);
  return { uid: decoded.uid, email: decoded.email ?? null };
}
