import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { Resend } from 'resend';

dotenv.config();

const app = express();
const port = Number(process.env.EMAIL_API_PORT || 8787);

const resendApiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const resend = resendApiKey ? new Resend(resendApiKey) : null;

app.use(cors());
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/send-strip', async (req, res) => {
  try {
    if (!resend) {
      return res.status(500).json({
        message: 'Email service is not configured. Set RESEND_API_KEY in .env.',
      });
    }

    const { email, imageDataUrl } = req.body ?? {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ message: 'A recipient email is required.' });
    }

    if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ message: 'A valid PNG image payload is required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    const base64Content = imageDataUrl.replace(/^data:image\/png;base64,/, '');

    const result = await resend.emails.send({
      from: fromEmail,
      to: email.trim(),
      subject: 'Your CozyCam Photostrip',
      html: '<p>Here is your CozyCam photostrip. Have fun sharing it!</p>',
      attachments: [
        {
          filename: `photobooth-${Date.now()}.png`,
          content: base64Content,
        },
      ],
    });

    if (result.error) {
      return res.status(400).json({
        message: result.error.message || 'Resend rejected the email request.',
      });
    }

    return res.json({ message: 'Photostrip sent successfully.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected email send error.';
    return res.status(500).json({ message });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Email API running at http://localhost:${port}`);
});
