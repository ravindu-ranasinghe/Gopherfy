const { Resend } = require('resend');

/**
 * Factory for the Resend-backed OTP email sender. API key comes from
 * loadSecrets() at OTP service bootstrap — do not read RESEND_API_KEY
 * from process.env here.
 *
 * @param {{ apiKey: string, fromEmail: string }} opts
 */
function createSendOtp({ apiKey, fromEmail }) {
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is required');
  }
  if (!fromEmail) {
    throw new Error('FROM_EMAIL is required');
  }
  const resend = new Resend(apiKey);

  return async function sendOtp(toEmail, code) {
    const response = await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      subject: 'Gopherfy verification code',
      text: `Your verification code is: ${code}\n\nExpires in 10 minutes. Do not share this code.`,
    });
    if (response.error) {
      throw new Error(response.error.message || 'Resend send failed');
    }
    return response;
  };
}

module.exports = { createSendOtp };
