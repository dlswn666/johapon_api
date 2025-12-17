import https from 'https';
import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { supabaseService } from './supabase.service';
import { SendAlimtalkRequest, AlimtalkTemplate, Recipient } from '../types/alimtalk.types';
import { AligoSendResponse, AligoTemplateListResponse, SenderKeyInfo } from '../types/aligo.types';
import { formatPhoneNumber } from '../utils/phone';

const ALIGO_BASE_URL = 'https://kakaoapi.aligo.in';

// 배치 처리 상수
const BATCH_SIZE = 500; // 알리고 API 최대 수신자 수

/**
 * 배치 발송 결과 타입
 */
interface BatchResult {
    batchIndex: number;
    success: boolean;
    kakaoSuccessCount: number;
    smsSuccessCount: number;
    failCount: number;
    actualCost: number; // 알리고 응답의 total 값 (실제 비용)
    aligoResponse: AligoSendResponse | null;
    error?: string;
}

/**
 * 전체 발송 결과 타입
 */
export interface SendResult {
    success: boolean;
    totalRecipients: number;
    totalBatches: number;
    kakaoSuccessCount: number;
    smsSuccessCount: number;
    failCount: number;
    totalActualCost: number; // 전체 실제 비용 (알리고 응답의 total 합산)
    batchResults: BatchResult[];
}

/**
 * 알리고 API 서비스
 */
class AligoService {
    private httpClient: AxiosInstance;

    constructor() {
        // Keep-Alive 설정으로 TCP 연결 재사용
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 10, // 최대 동시 연결 수
            maxFreeSockets: 5, // 유지할 유휴 연결 수
            timeout: 30000, // 30초 타임아웃
        });

        this.httpClient = axios.create({
            baseURL: ALIGO_BASE_URL,
            timeout: 30000,
            httpsAgent,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });
    }

    /**
     * Sender Key 조회 (Vault)
     * 조합별 키가 없으면 기본 키(조합온) 사용
     */
    async getSenderKey(unionId: string): Promise<SenderKeyInfo> {
        // 조합별 Sender Key 조회 시도
        const unionSenderKey = await supabaseService.getUnionSenderKey(unionId);

        if (unionSenderKey) {
            const channelName = await supabaseService.getUnionChannelName(unionId);
            return {
                senderKey: unionSenderKey,
                channelName,
                isDefault: false,
            };
        }

        // 기본 Sender Key 사용
        const defaultSenderKey = await supabaseService.getDefaultSenderKey();
        return {
            senderKey: defaultSenderKey,
            channelName: env.DEFAULT_CHANNEL_NAME,
            isDefault: true,
        };
    }

    /**
     * 배열을 지정된 크기로 분할
     */
    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    /**
     * 단일 배치 알림톡 발송 (최대 500건)
     */
    private async sendBatch(
        recipients: Recipient[],
        templateCode: string,
        title: string,
        senderKeyInfo: SenderKeyInfo,
        batchIndex: number
    ): Promise<BatchResult> {
        // 알리고 API 파라미터 구성
        const formData = new URLSearchParams({
            apikey: env.ALIGO_API_KEY,
            userid: env.ALIGO_USER_ID,
            senderkey: senderKeyInfo.senderKey,
            tpl_code: templateCode,
            sender: env.ALIGO_SENDER_PHONE,
        });

        // 대체발송 활성화 여부 확인 (수신자 중 하나라도 대체발송 메시지가 있으면 활성화)
        const hasFailover = recipients.some((r) => r.failoverMessage);

        // 수신자 정보 추가 (최대 500건)
        recipients.forEach((recipient, index) => {
            const idx = index + 1;
            const phoneNumber = formatPhoneNumber(recipient.phoneNumber);

            formData.append(`receiver_${idx}`, phoneNumber);
            formData.append(`subject_${idx}`, title);

            // 메시지 생성: content가 있으면 content 사용, 없으면 title 사용
            let message = recipient.content || title;

            // 변수 치환 적용
            if (recipient.variables) {
                for (const [key, value] of Object.entries(recipient.variables)) {
                    message = message.replace(new RegExp(`#{${key}}`, 'g'), value);
                }
            }
            formData.append(`message_${idx}`, message);

            // 버튼 정보 추가 (있는 경우)
            if (recipient.buttons && recipient.buttons.length > 0) {
                // 버튼 링크에도 변수 치환 적용
                const buttonsWithVars = recipient.buttons.map((btn) => {
                    let linkMo = btn.linkMo;
                    let linkPc = btn.linkPc || '';
                    if (recipient.variables) {
                        for (const [key, value] of Object.entries(recipient.variables)) {
                            linkMo = linkMo.replace(new RegExp(`#{${key}}`, 'g'), value);
                            if (linkPc) {
                                linkPc = linkPc.replace(new RegExp(`#{${key}}`, 'g'), value);
                            }
                        }
                    }
                    return {
                        name: btn.name,
                        linkType: btn.linkType,
                        linkTypeName: btn.linkTypeName,
                        linkMo: linkMo,
                        linkPc: linkPc,
                    };
                });

                // 알리고 API 버튼 형식으로 JSON 생성
                const buttonJson = JSON.stringify({ button: buttonsWithVars });
                formData.append(`button_${idx}`, buttonJson);
            }

            // 대체발송 메시지 추가 (LMS)
            if (hasFailover && recipient.failoverSubject && recipient.failoverMessage) {
                // 대체발송 제목에도 변수 치환 적용
                let failoverSubject = recipient.failoverSubject;
                let failoverMessage = recipient.failoverMessage;
                if (recipient.variables) {
                    for (const [key, value] of Object.entries(recipient.variables)) {
                        failoverSubject = failoverSubject.replace(new RegExp(`#{${key}}`, 'g'), value);
                        failoverMessage = failoverMessage.replace(new RegExp(`#{${key}}`, 'g'), value);
                    }
                }
                formData.append(`fsubject_${idx}`, failoverSubject);
                formData.append(`fmessage_${idx}`, failoverMessage);
            }
        });

        // 대체발송 설정 (알림톡 실패 시 LMS 발송)
        formData.append('failover', hasFailover ? 'Y' : 'N');

        try {
            const response = await this.httpClient.post<AligoSendResponse>(
                '/akv10/alimtalk/send/',
                formData.toString()
            );

            const result = response.data;

            console.log(`[배치 ${batchIndex + 1}] 알리고 API 응답:`, JSON.stringify(result, null, 2));

            // 응답 분석
            if (result.code === 0 && result.info) {
                const kakaoSuccessCount = result.info.scnt || 0;
                const failCount = result.info.fcnt || 0;
                const smsSuccessCount = 0; // 상세 결과에서 확인 필요
                const actualCost = result.info.total || 0; // 알리고 응답의 실제 비용

                console.log(`[배치 ${batchIndex + 1}] 실제 비용: ${actualCost}원`);

                return {
                    batchIndex,
                    success: true,
                    kakaoSuccessCount,
                    smsSuccessCount,
                    failCount,
                    actualCost,
                    aligoResponse: result,
                };
            } else {
                console.error(`[배치 ${batchIndex + 1}] 알리고 API 오류:`, result.message);
                return {
                    batchIndex,
                    success: false,
                    kakaoSuccessCount: 0,
                    smsSuccessCount: 0,
                    failCount: recipients.length,
                    actualCost: 0,
                    aligoResponse: result,
                    error: result.message,
                };
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '알 수 없는 오류';
            console.error(`[배치 ${batchIndex + 1}] 알리고 API 호출 오류:`, error);
            return {
                batchIndex,
                success: false,
                kakaoSuccessCount: 0,
                smsSuccessCount: 0,
                failCount: recipients.length,
                actualCost: 0,
                aligoResponse: null,
                error: errorMessage,
            };
        }
    }

    /**
     * 알림톡 발송 (대량 배치 처리 지원)
     * 500건씩 분할하여 순차 발송
     */
    async sendAlimtalk(request: SendAlimtalkRequest): Promise<SendResult> {
        const { unionId, templateCode, title, recipients } = request;

        // Sender Key 조회
        const senderKeyInfo = await this.getSenderKey(unionId);

        // 수신자를 500건씩 분할
        const batches = this.chunkArray(recipients, BATCH_SIZE);
        const totalBatches = batches.length;

        console.log(`[알림톡 발송] 총 ${recipients.length}명, ${totalBatches}개 배치로 분할`);

        const batchResults: BatchResult[] = [];
        let totalKakaoSuccess = 0;
        let totalSmsSuccess = 0;
        let totalFail = 0;
        let totalActualCost = 0;

        // 순차적으로 배치 처리 (병렬 처리 시 알리고 API 부하 고려)
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            console.log(`[배치 ${i + 1}/${totalBatches}] ${batch.length}명 발송 시작`);

            const result = await this.sendBatch(batch, templateCode, title, senderKeyInfo, i);

            batchResults.push(result);
            totalKakaoSuccess += result.kakaoSuccessCount;
            totalSmsSuccess += result.smsSuccessCount;
            totalFail += result.failCount;
            totalActualCost += result.actualCost;

            // 배치 간 딜레이 (알리고 API 부하 방지)
            if (i < batches.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        // 전체 성공 여부 (모든 배치가 성공해야 전체 성공)
        const allSuccess = batchResults.every((r) => r.success);

        console.log(
            `[알림톡 발송 완료] 성공: ${totalKakaoSuccess}, SMS: ${totalSmsSuccess}, 실패: ${totalFail}, 비용: ${totalActualCost}원`
        );

        return {
            success: allSuccess,
            totalRecipients: recipients.length,
            totalBatches,
            kakaoSuccessCount: totalKakaoSuccess,
            smsSuccessCount: totalSmsSuccess,
            failCount: totalFail,
            totalActualCost,
            batchResults,
        };
    }

    /**
     * 템플릿 목록 조회
     */
    async getTemplateList(): Promise<AlimtalkTemplate[]> {
        const formData = new URLSearchParams({
            apikey: env.ALIGO_API_KEY,
            userid: env.ALIGO_USER_ID,
            senderkey: env.DEFAULT_SENDER_KEY,
        });

        try {
            const response = await this.httpClient.post<AligoTemplateListResponse>(
                '/akv10/template/list/',
                formData.toString()
            );

            const result = response.data;

            console.log('알리고 템플릿 조회 응답:', JSON.stringify(result, null, 2));

            if (result.code !== 0 || !result.list) {
                console.error('템플릿 조회 실패:', result.message);
                return [];
            }

            // 알리고 템플릿을 내부 형식으로 변환
            return result.list.map((template) => ({
                template_code: template.templtCode,
                template_name: template.templtName,
                template_content: template.templtContent,
                status: template.status,
                insp_status: template.inspStatus,
                buttons: template.buttons,
            }));
        } catch (error) {
            console.error('템플릿 조회 오류:', error);
            throw new Error('템플릿 조회에 실패했습니다.');
        }
    }
}

export const aligoService = new AligoService();
export default aligoService;
