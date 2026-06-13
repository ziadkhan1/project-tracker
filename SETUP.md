# Project Tracker — Firebase setup (one-time, ~5 min)

The app uses **Firebase Auth** (Google sign-in) and **Cloud Firestore** (tasks +
the user allowlist). The free *Spark* plan is plenty. You only do this once.

## 1. Create a Firebase project
1. Go to <https://console.firebase.google.com> → **Add project**.
2. Name it (e.g. `project-tracker`), accept defaults, finish. Analytics optional.

## 2. Add a Web app
1. In the project, click the **`</>`** (Web) icon → register an app (any nickname).
2. Firebase shows a `firebaseConfig` object. Copy those values into
   [`firebase-config.js`](firebase-config.js), replacing every `REPLACE_ME`.
3. Leave `OWNER_EMAIL` as the Google account that should be the first admin
   (defaults to `xiyadkhan@gmail.com`). It must match `owner()` in
   [`../firestore.rules`](../firestore.rules).

## 3. Enable Google sign-in
1. **Build → Authentication → Get started**.
2. **Sign-in method → Google → Enable**, pick a support email, **Save**.
3. **Authentication → Settings → Authorized domains → Add domain**:
   add `ziadkhan1.github.io` (your GitHub Pages host). `localhost` is there by
   default for local testing.

## 4. Create the database + rules
1. **Build → Firestore Database → Create database** → **Production mode** →
   pick a location → Enable.
2. Open the **Rules** tab, paste the contents of
   [`../firestore.rules`](../firestore.rules), and **Publish**.

## 5. Done — bootstrap the first admin
1. Open the app, **Sign in with Google** as the `OWNER_EMAIL` account.
   The owner is auto-granted admin on first sign-in.
2. Click **⚙ Admin** → add teammates by their Google email (Member or Admin).
   They can sign in immediately; everything syncs live across devices.

## Notes
- The values in `firebase-config.js` are **public identifiers**, not secrets —
  it's normal and safe to commit them. Access is enforced by the Firestore rules,
  not by hiding the config.
- To run locally: serve `docs/` (`python -m http.server 8765`) and open
  <http://127.0.0.1:8765/>. `localhost` is pre-authorised in Firebase.
