import { AuthenticatedKey } from '../auth';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedKey;
    }
  }
}
