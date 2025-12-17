import { Router } from 'express';
import healthRouter from './health';
import alimtalkRouter from './alimtalk';

const router = Router();

// 헬스체크 라우트
router.use('/health', healthRouter);

// 알림톡 API 라우트
router.use('/api/alimtalk', alimtalkRouter);

export default router;

