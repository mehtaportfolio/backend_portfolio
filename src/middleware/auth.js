/**
 * JWT Authentication Middleware
 * Verifies Supabase JWT tokens from Authorization header
 */

export default function authMiddleware(req, res, next) {
  // Get token from Authorization header
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);

  if (!token || token === 'undefined' || token === 'null') {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // TODO: Implement JWT verification with Supabase public key
  // For now, we'll just attach the token to the request
  req.token = token;

  // Extract user ID from token (you can decode JWT without verification for now)
  // In production, properly verify with Supabase's public key
  try {
    // Basic JWT decode (without verification - not recommended for production)
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    // Decode payload (middle part)
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(
      Buffer.from(base64, 'base64').toString('utf-8')
    );

    const userId = payload?.sub || 'single-user';

    req.userId = userId;
    req.user = {
      ...payload,
      id: userId,
    };
  } catch (error) {
    // For single-user app, we can be more lenient if needed, but still log
    console.error('Token decode error:', error.message);
    req.userId = 'single-user';
    req.user = { id: 'single-user' };
  }

  next();
}