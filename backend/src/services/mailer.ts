import nodemailer, { Transporter } from 'nodemailer';
import { env, senders, SenderAccount } from '../config/env';

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  body: string;
}

export interface SendResult {
  messageId: string;
  previewUrl: string | null;
}

/** Anything that can send an email. Production uses Ethereal SMTP; tests inject a fake. */
export interface Mailer {
  send(email: OutgoingEmail): Promise<SendResult>;
}

/** Real SMTP mailer: one cached nodemailer transport per Ethereal sender account. */
export class EtherealMailer implements Mailer {
  private transports = new Map<string, Transporter>();

  constructor(private readonly accounts: SenderAccount[] = senders) {}

  private transportFor(senderEmail: string): Transporter {
    const cached = this.transports.get(senderEmail);
    if (cached) return cached;
    const account = this.accounts.find((a) => a.email === senderEmail);
    if (!account) throw new Error(`Unknown sender "${senderEmail}" (not in ETHEREAL_SENDERS)`);
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: false,
      auth: { user: account.email, pass: account.password },
    });
    this.transports.set(senderEmail, transport);
    return transport;
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const info = await this.transportFor(email.from).sendMail({
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.body,
    });
    const preview = nodemailer.getTestMessageUrl(info);
    return { messageId: info.messageId, previewUrl: preview || null };
  }
}
