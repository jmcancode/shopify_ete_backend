require("dotenv").config();
const admin = require("firebase-admin");

const initFirebase = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    );
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    admin.initializeApp();
  }
};

const setAdmin = async (emailOrUid) => {
  try {
    initFirebase();

    let user;
    if (emailOrUid.includes("@")) {
      console.log(`Looking up user by email: ${emailOrUid}`);
      user = await admin.auth().getUserByEmail(emailOrUid);
    } else {
      console.log(`Looking up user by UID: ${emailOrUid}`);
      user = await admin.auth().getUser(emailOrUid);
    }

    console.log(`Found user: ${user.email} (${user.uid})`);

    await admin.auth().setCustomUserClaims(user.uid, { admin: true });

    console.log("✓ Admin claim set successfully!");
    console.log(
      "User must sign out and sign back in for changes to take effect.",
    );

    process.exit(0);
  } catch (error) {
    console.error("✗ Error:", error.message);
    process.exit(1);
  }
};

const emailOrUid = process.argv[2];

if (!emailOrUid) {
  console.log("Usage: node set-admin.js <email-or-uid>");
  console.log("Example: node set-admin.js admin@mobrostcg.com");
  process.exit(1);
}

setAdmin(emailOrUid);
