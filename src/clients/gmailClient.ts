import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
}

export class GmailClient {
  private gmail;

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async getRecentUnread(hoursBack: number): Promise<GmailMessage[]> {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const afterEpoch = Math.floor(since.getTime() / 1000);

    const listResponse = await this.gmail.users.messages.list({
      userId: 'me',
      q: `is:unread after:${afterEpoch}`,
      maxResults: 50,
    });

    const messageRefs = listResponse.data.messages ?? [];
    if (messageRefs.length === 0) return [];

    const messages = await Promise.all(
      messageRefs.map(async (ref) => {
        const msg = await this.gmail.users.messages.get({
          userId: 'me',
          id: ref.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });

        const headers = msg.data.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

        const receivedMs = parseInt(msg.data.internalDate ?? '0', 10);
        const receivedAt = new Date(receivedMs).toISOString();
        const snippet = (msg.data.snippet ?? '').substring(0, 200);

        return {
          id: msg.data.id ?? '',
          threadId: msg.data.threadId ?? '',
          from: getHeader('From'),
          subject: getHeader('Subject'),
          snippet,
          receivedAt,
        } satisfies GmailMessage;
      })
    );

    return messages;
  }
}
