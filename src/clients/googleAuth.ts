import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function createOAuth2Client(credentials: GoogleCredentials): OAuth2Client {
  const oauth2Client = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    'urn:ietf:wg:oauth:2.0:oob'
  );

  oauth2Client.setCredentials({
    refresh_token: credentials.refreshToken,
  });

  return oauth2Client;
}
