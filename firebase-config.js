// ─────────────────────────────────────────────────────────────────────────
//  Firebase web config
//  These values are PUBLIC identifiers, not secrets — they are safe to commit.
//  Real security is enforced server-side by Firestore rules (see firestore.rules),
//  not by hiding this config.
//
//  Fill these in from:
//    Firebase console → Project settings (⚙) → Your apps → Web app → "SDK setup
//    and configuration" → Config.
//
//  See SETUP.md in this folder for the full one-time setup walkthrough.
// ─────────────────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey:            "REPLACE_ME",
  authDomain:        "REPLACE_ME.firebaseapp.com",
  projectId:         "REPLACE_ME",
  storageBucket:     "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId:             "REPLACE_ME",
};

// Bootstrap owner. This email is always treated as an admin and can sign in even
// before the allowlist has anyone in it — that's how you get the first admin in.
// It MUST match the `owner()` email hard-coded in firestore.rules.
export const OWNER_EMAIL = "xiyadkhan@gmail.com";
