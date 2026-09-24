import { google } from "googleapis";
import { env } from "./env.js";

/**
 * Full drive scope: the backend uploads, reads and deletes.
 *
 * drive.file would be tighter (access limited to files this app created) but
 * it cannot see a pre-existing folder that a human shared with the service
 * account, which is exactly how GOOGLE_DRIVE_FOLDER_ID is provisioned.
 */
const SCOPES = ["https://www.googleapis.com/auth/drive"];

const authOptions = {
  credentials: {
    client_email: env.google.clientEmail,
    private_key: env.google.privateKey,
  },
  scopes: SCOPES,
};

// Domain-wide delegation: act as a real Workspace user so uploads consume that
// user's storage quota instead of the service account's (which is zero).
if (env.google.impersonateUser) {
  authOptions.clientOptions = { subject: env.google.impersonateUser };
}

const auth = new google.auth.GoogleAuth(authOptions);

export const drive = google.drive({ version: "v3", auth });

/**
 * Every Drive call in this app must be Shared Drive aware. Centralising these
 * flags means a single place to change if the storage target moves.
 */
export const sharedDriveParams = env.google.sharedDriveId
  ? {
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      driveId: env.google.sharedDriveId,
      corpora: "drive",
    }
  : { supportsAllDrives: true, includeItemsFromAllDrives: true };

/** Write calls accept supportsAllDrives but reject driveId/corpora. */
export const sharedDriveWriteParams = { supportsAllDrives: true };

export const ROOT_FOLDER_ID = env.google.rootFolderId;
