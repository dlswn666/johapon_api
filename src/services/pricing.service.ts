import { supabaseService } from './supabase.service';

/**
 * 발송 비용 계산 서비스
 */
class PricingService {
    /**
     * 발송 비용 계산
     */
    async calculateCost(kakaoCount: number, smsCount: number): Promise<number> {
        const pricing = await supabaseService.getCurrentPricing();
        
        const kakaoCost = kakaoCount * pricing.KAKAO;
        const smsCost = smsCount * pricing.SMS;
        
        return kakaoCost + smsCost;
    }
}

export const pricingService = new PricingService();
export default pricingService;

