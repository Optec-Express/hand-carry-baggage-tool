// Exposes non-secret front-end config. The Google OAuth *client ID* is public
// by design (it ships in the browser), so serving it from an env var just keeps
// it out of the committed HTML and lets you configure it per-deployment.
//
// Setup: create an OAuth 2.0 Client ID (type: Web application) in Google Cloud
// Console, add your site's URL under "Authorized JavaScript origins", then add
// the client ID to the Vercel project's Environment Variables as
// GOOGLE_CLIENT_ID. Optionally set GOOGLE_HD to your Workspace domain
// (e.g. optec-exp.com) to restrict sign-in to company accounts.
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    googleHd: process.env.GOOGLE_HD || null,
  });
}
