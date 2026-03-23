import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

export interface EmailParams {
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

export class SesClient {
  private ses: SESClient;

  constructor(region: string) {
    this.ses = new SESClient({ region });
  }

  async sendEmail(params: EmailParams): Promise<void> {
    const command = new SendEmailCommand({
      Source: params.from,
      Destination: {
        ToAddresses: [params.to],
      },
      Message: {
        Subject: {
          Data: params.subject,
          Charset: 'UTF-8',
        },
        Body: {
          Html: {
            Data: params.htmlBody,
            Charset: 'UTF-8',
          },
          Text: {
            Data: params.textBody,
            Charset: 'UTF-8',
          },
        },
      },
    });

    await this.ses.send(command);
  }
}
