import type { FullGisSourceId } from './full-lookup-contract';

type Row = Record<string, unknown>;

export class FullGisProjectionError extends Error {
    constructor() { super('PUBLIC_GIS_FIELD_INVALID'); }
}

const registryFields = [
    'pnu', 'mgmBldrgstPk', 'regstrGbCd', 'regstrGbCdNm', 'regstrKindCd',
    'regstrKindCdNm', 'platPlc', 'newPlatPlc', 'sigunguCd', 'bjdongCd',
    'platGbCd', 'bun', 'ji', 'bldNm', 'dongNm', 'mainAtchGbCd',
    'mainAtchGbCdNm', 'mainPurpsCd', 'mainPurpsCdNm', 'etcPurps',
    'strctCd', 'strctCdNm', 'etcStrct', 'crtnDay',
] as const;
const fields: Partial<Record<FullGisSourceId, readonly string[]>> = {
    building_title: [...registryFields, 'totArea', 'totlAr', 'archArea', 'platArea',
        'vlRatEstmTotArea', 'bcRat', 'vlRat', 'grndFlrCnt', 'ugrndFlrCnt',
        'hhldCnt', 'hoCnt', 'fmlyCnt', 'useAprDay', 'pmsDay', 'stcnsDay'],
    building_units: [...registryFields, 'hoNm', 'flrGbCd', 'flrGbCdNm', 'flrNo',
        'flrNoNm', 'area', 'exposPubuseGbCd', 'exposPubuseGbCdNm'],
    building_floors: [...registryFields, 'flrGbCd', 'flrGbCdNm', 'flrNo',
        'flrNoNm', 'area', 'areaExctYn'],
    land_registry: ['pnu', 'ldCode', 'ldCodeNm', 'mnnmSlno', 'regstrSeCode',
        'regstrSeCodeNm', 'lndcgrCode', 'lndcgrCodeNm', 'lndpclAr',
        'posesnSeCode', 'posesnSeCodeNm', 'cnrsPsnCo', 'ladFrtlSc',
        'ladFrtlScNm', 'lastUpdtDt'],
    land_share_registry: ['pnu', 'agbldgSn', 'buldNm', 'buldDongNm',
        'buldFloorNm', 'buldHoNm', 'buldRoomNm', 'ldaQotaRate', 'clsSeCode',
        'clsSeCodeNm', 'relateLdEmdLiCode', 'lastUpdtDt'],
    building_ho_land_share: ['pnu', 'ldCode', 'ldCodeNm', 'mnnmSlno', 'agbldgSn',
        'buldNm', 'buldDongNm', 'buldFloorNm', 'buldHoNm', 'buldRoomNm',
        'ldaQotaRate', 'clsSeCode', 'clsSeCodeNm', 'liCode', 'liCodeNm',
        'regstrSeCode', 'regstrSeCodeNm', 'relateLdEmdLiCode', 'lastUpdtDt'],
    land_price: ['pnu', 'ldCode', 'ldCodeNm', 'mnnmSlno', 'stdrYear', 'stdrMt',
        'pblntfPclnd', 'lastUpdtDt'],
    apart_price: ['pnu', 'ldCode', 'ldCodeNm', 'aphusCode', 'aphusNm', 'dongNm',
        'hoNm', 'floorNm', 'aphusSeCode', 'aphusSeCodeNm', 'regstrSeCode',
        'regstrSeCodeNm', 'mnnmSlno', 'spclLandNm', 'stdrYear', 'stdrMt',
        'prvuseAr', 'pblntfPc', 'lastUpdtDt'],
    indiv_house_price: ['pnu', 'ldCode', 'ldCodeNm', 'mnnmSlno', 'bldNm',
        'bildRegstrEsntlNo', 'mgmBldrgstPk', 'bdMgtSn', 'stdrYear', 'stdrMt',
        'landAr', 'buldAr', 'housePc', 'lastUpdtDt'],
};

/** 수치/분수/빈칸을 원자료 그대로 둔다. 중첩 객체나 미허용 필드는 전달하지 않는다. */
export function projectFullGisRecord(id: FullGisSourceId, row: Row): Row {
    const result: Row = {};
    for (const key of fields[id] ?? []) {
        const value = row[key];
        if (value === undefined) continue;
        if (value === null || typeof value === 'boolean') result[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
        else if (typeof value === 'string' && value.length <= 300) result[key] = value;
        else throw new FullGisProjectionError();
    }
    if (id === 'land_price') result.priceUnit = 'KRW_PER_SQUARE_METER';
    if (id === 'apart_price' || id === 'indiv_house_price') result.priceUnit = 'KRW';
    if (id.startsWith('building_') && id !== 'building_ho_land_share') {
        result.areaUnit = 'SQUARE_METER';
    }
    return result;
}

/** geometry에서도 공급자 properties 등 임의 필드가 밖으로 나가지 않게 한다. */
export function projectFullGisGeometry(value: unknown): Row | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Row;
    if (candidate.type !== 'Polygon' && candidate.type !== 'MultiPolygon') return null;
    let positionCount = 0;
    const position = (point: unknown): number[] | null => {
        if (!Array.isArray(point) || point.length < 2) return null;
        const [longitude, latitude] = point;
        if (typeof longitude !== 'number' || !Number.isFinite(longitude)
            || longitude < -180 || longitude > 180
            || typeof latitude !== 'number' || !Number.isFinite(latitude)
            || latitude < -90 || latitude > 90 || ++positionCount > 1_000) return null;
        return [longitude, latitude];
    };
    const polygon = (rings: unknown): number[][][] | null => {
        if (!Array.isArray(rings) || rings.length === 0) return null;
        const projected: number[][][] = [];
        for (const ring of rings) {
            if (!Array.isArray(ring) || ring.length < 4) return null;
            const points: number[][] = [];
            for (const point of ring) {
                const safe = position(point);
                if (!safe) return null;
                points.push(safe);
            }
            if (points[0][0] !== points[points.length - 1][0]
                || points[0][1] !== points[points.length - 1][1]) return null;
            projected.push(points);
        }
        return projected;
    };
    if (candidate.type === 'Polygon') {
        const coordinates = polygon(candidate.coordinates);
        return coordinates ? { type: 'Polygon', coordinates } : null;
    }
    if (!Array.isArray(candidate.coordinates) || candidate.coordinates.length === 0) return null;
    const coordinates: number[][][][] = [];
    for (const item of candidate.coordinates) {
        const safe = polygon(item);
        if (!safe) return null;
        coordinates.push(safe);
    }
    return { type: 'MultiPolygon', coordinates };
}
