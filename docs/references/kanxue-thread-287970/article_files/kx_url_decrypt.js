// 解密函数
function kx_url_decrypt(str) {
    try {
        // 检查是否已经是解密后的URL格式
        if (str.includes('http://') || str.includes('https://') || str.includes('www.')) {
            return str;
        }


        
        // 1. 移除salt
        const encrypted = str.slice(3);

        
        // 2. 定义替换规则的反向映射
        const replacePairs = {
            'K9': 'a', 'L8': 'b', 'M7': 'c',
            'N6': 'd', 'P5': 'e', 'Q4': 'f',
            'R3': 'g', 'S2': 'h', 'T1': 'i',
            'U0': 'j', 'V1': 'k', 'W2': 'l',
            'X3': 'm', 'Y4': 'n', 'Z5': 'o',
            'A6': 'p', 'B7': 'q', 'C8': 'r',
            'D9': 's', 'E0': 't', 'F1': 'u',
            'G2': 'v', 'H3': 'w', 'I4': 'x',
            'J5': 'y', 'K6': 'z',
            'l9': 'A', 'm8': 'B', 'n7': 'C',
            'o6': 'D', 'p5': 'E', 'q4': 'F',
            'r3': 'G', 's2': 'H', 't1': 'I',
            'u0': 'J', 'v1': 'K', 'w2': 'L',
            'x3': 'M', 'y4': 'N', 'z5': 'O',
            'a6': 'P', 'b7': 'Q', 'c8': 'R',
            'd9': 'S', 'e0': 'T', 'f1': 'U',
            'g2': 'V', 'h3': 'W', 'i4': 'X',
            'j5': 'Y', 'k6': 'Z',
            '@1': '0', '#2': '1', '$3': '2',
            '%4': '3', '^5': '4', '&6': '5',
            '*7': '6', '(8': '7', ')9': '8',
            '!0': '9', '-_': '+', '|~': '/',
            '`.': '='
        };
        
        // 3. 按长度排序替换规则
        const sortedPairs = Object.entries(replacePairs)
            .sort((a, b) => b[0].length - a[0].length);
        
        // 4. 执行替换
        let base64 = encrypted;
        for (const [pattern, replacement] of sortedPairs) {
            base64 = base64.split(pattern).join(replacement);
        }

        
        // 5. 补全base64字符串的等号
        while (base64.length % 4) {
            base64 += '=';
        }

        
        // 6. 清理非法字符
        base64 = base64.replace(/[^A-Za-z0-9+/=]/g, '');

        
        // 7. base64解码
        const decoded = atob(base64);

        return decoded;
    } catch (e) {

        return str; // 如果解密失败，返回原始字符串
    }
}
