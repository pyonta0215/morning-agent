import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location?: string;
  description?: string;
}

export class CalendarClient {
  private calendar;

  constructor(auth: OAuth2Client) {
    this.calendar = google.calendar({ version: 'v3', auth });
  }

  async getTodayEvents(date: Date): Promise<CalendarEvent[]> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const response = await this.calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const items = response.data.items ?? [];

    return items.map((item) => {
      const isAllDay = !item.start?.dateTime;
      return {
        id: item.id ?? '',
        title: item.summary ?? '(タイトルなし)',
        start: item.start?.dateTime ?? item.start?.date ?? '',
        end: item.end?.dateTime ?? item.end?.date ?? '',
        isAllDay,
        location: item.location ?? undefined,
        description: item.description ?? undefined,
      };
    });
  }
}
