import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  type Auth,
  type User,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyCflFKYNxWYRx5OI6qtuyb2cud7NcstKak',
  authDomain: 'iron-broth.firebaseapp.com',
  projectId: 'iron-broth',
  storageBucket: 'iron-broth.firebasestorage.app',
  messagingSenderId: '787501263111',
  appId: '1:787501263111:web:e1b2c531f66f55ceb5bda2',
  measurementId: 'G-J8VXJCV356',
};

const app = initializeApp(firebaseConfig);

export const auth: Auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function registerWithEmail(email: string, password: string): Promise<User> {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function signOut(): Promise<void> {
  await fbSignOut(auth);
}

/** Returns a fresh Firebase ID token for the currently signed-in user. */
export async function getIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  return user.getIdToken();
}
