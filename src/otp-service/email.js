require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendOtp(toEmail, code) {
  const response = await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: toEmail,
    subject: 'Gopherfy verification code',
    text: `Your verification code is: ${code}\n\nExpires in 10 minutes. Do not share this code.`,
  });
  if (response.error) {
    throw new Error(response.error.message || 'Resend send failed');
  }
  return response;
}

module.exports = { sendOtp };
