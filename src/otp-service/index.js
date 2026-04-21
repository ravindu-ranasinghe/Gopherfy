require('dotenv').config();
const express = require('express');
const { checkRateLimit, createOtp, validateOtp } = require('./otp');
const { sendOtp } = require('./email');

const app = express();
app.use(express.json());

const port = process.env.OTP_SERVICE_PORT || 3001;

app.post('/send', async (req, res) => {
  const { discordId, email } = req.body;

  if (!checkRateLimit(discordId)) {
    return res.json({ ok: false, reason: 'rate_limited' });
  }

  const code = createOtp(discordId, email);

  try {
    await sendOtp(email, code);
    return res.json({ ok: true });
  } catch (err) {
    console.error('sendOtp failed:', err);
    return res.json({ ok: false, reason: 'send_failed' });
  }
});

app.post('/verify', (req, res) => {
  const { discordId, code } = req.body;
  const result = validateOtp(discordId, code);
  return res.json(result);
});

app.listen(port, () => console.log(`OTP service running on port ${port}`));
