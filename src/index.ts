import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import routes from './routes';
import { loggerMiddleware, errorHandler, notFoundHandler } from './middleware';

// Express 앱 생성
const app = express();

// 미들웨어 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(loggerMiddleware);

// 라우트 설정
app.use(routes);

// 404 핸들러
app.use(notFoundHandler);

// 에러 핸들러
app.use(errorHandler);

// 서버 시작
const server = app.listen(env.PORT, () => {
    console.log('='.repeat(60));
    console.log('  알림톡 프록시 서버 (Alimtalk Proxy Server)');
    console.log('='.repeat(60));
    console.log(`  환경: ${env.NODE_ENV}`);
    console.log(`  포트: ${env.PORT}`);
    console.log(`  시작 시간: ${new Date().toISOString()}`);
    console.log('='.repeat(60));
    console.log('');
    console.log('  API 엔드포인트:');
    console.log(`    GET  /health              - 헬스체크`);
    console.log(`    POST /api/alimtalk/send   - 알림톡 발송`);
    console.log(`    POST /api/alimtalk/sync-templates - 템플릿 동기화`);
    console.log('');
    console.log('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM 시그널 수신. 서버 종료 중...');
    server.close(() => {
        console.log('서버가 정상적으로 종료되었습니다.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT 시그널 수신. 서버 종료 중...');
    server.close(() => {
        console.log('서버가 정상적으로 종료되었습니다.');
        process.exit(0);
    });
});

export default app;

