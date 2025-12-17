import { SendAlimtalkRequest } from './alimtalk.types';
import { SendResult } from '../services/aligo.service';

/**
 * 작업 상태
 */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * 작업 메타데이터
 */
export interface JobMetadata {
    /** 작업 고유 ID */
    jobId: string;
    /** 조합 ID */
    unionId: string;
    /** 발송자 ID */
    senderId: string;
    /** 템플릿 코드 */
    templateCode: string;
    /** 수신자 수 */
    recipientCount: number;
    /** 생성 시간 */
    createdAt: Date;
}

/**
 * 작업 정보
 */
export interface JobInfo extends JobMetadata {
    /** 작업 상태 */
    status: JobStatus;
    /** 시작 시간 */
    startedAt?: Date;
    /** 완료 시간 */
    completedAt?: Date;
    /** 결과 (완료 시) */
    result?: SendResult;
    /** 오류 메시지 (실패 시) */
    error?: string;
}

/**
 * 작업 요청
 */
export interface JobRequest {
    request: SendAlimtalkRequest;
    metadata: JobMetadata;
}

/**
 * 큐 상태 정보
 */
export interface QueueStatus {
    /** 대기 중인 작업 수 */
    pending: number;
    /** 처리 중인 작업 수 */
    running: number;
    /** 동시 처리 수 설정 */
    concurrency: number;
    /** 큐 최대 크기 */
    maxSize: number;
    /** 큐 가득 참 여부 */
    isFull: boolean;
}

