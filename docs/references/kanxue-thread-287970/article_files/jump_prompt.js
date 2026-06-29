// 主域名
function getMainDomain(domain) {
    // domain对应hostname
    const parts = domain.split('.');  
    return parts.slice(-2).join('.');  
} 
// 子域名
function isSubdomain(subdomain) { 
    var currentDomain = window.location.hostname;  // 当前域名 
    const mainDomain1 = getMainDomain(currentDomain); 
    const mainDomain2 = getMainDomain(subdomain); 
    if (mainDomain1 === mainDomain2) { 
        // console.log(' 主域名一致'); 
        return true; 
    } else { 
        // console.log(' 主域名不一致'); 
        return false; 
    } 
} 
// 特殊链接处理
function handleLinkClick(href) {
    if (href.includes('//bbs.kanxue.cn/target-') || href.includes('//bbs.kanxue.com/target-') || href.includes('//bbs.pediy.cn/target-') || href.includes('//bbs.pediy.com/target-'))  {
        // 特殊链接处理
        return true
    }
    return false;
}

function isThirdPartyLink(urlString) {
    const thirdPartyDomains = [
        'pediy.com'
    ];
    const url = new URL(urlString); 
    const hostname = url.hostname;  
    const mainDomain = getMainDomain(hostname);

    if (thirdPartyDomains.includes(mainDomain)) {
        return true;
    }
    return false;
}
// 监听点击a标签
$('body').on('click', 'a',function(event) {
    
    if(!Boolean($(this).attr('href'))){
        return;
    }
    // 判断是否为http或https协议
    const url = new URL(this.href);
    if (url.protocol  === 'http:' || url.protocol  === 'https:') {
        // 获取当前域名
        var currentDomain = window.location.hostname;
        // 获取链接地址
        var href = this.href;
        // 判断是否为第三方链接
        if (href.indexOf(getMainDomain(currentDomain))  === -1) {
            console.log(' 是第三方链接');
            // 第三方白名单判断
            if (isThirdPartyLink(href)) {
                // console.log(' 是白名单链接');
                return;
            }
            // 阻止默认行为
            event.preventDefault();
            var targetUrl = href; 
            window.open('link.htm?url='  + encodeURIComponent(targetUrl), '_blank');
            
        } else {
            // console.log(' 不是一个第三方');
            let href_ = $(this).attr('href');
            // 判断href_是否包含elink@，如果包含，则移除elink@并返回新字符串
            if (href_.indexOf('elink@') !== -1) {
                event.preventDefault();
                href_ = href_.replace('elink@', '');
                let decodedContent = xn.urldecode(kx_url_decrypt(href_));
                
                window.open(decodedContent, '_blank');
                return;
            }
            if(handleLinkClick(this.href)) {
                event.preventDefault(); 
                var targetUrl = this.href; 
                window.open('link.htm?url='  + encodeURIComponent(targetUrl), '_blank');
                return;
            }
        }
    } else { 
        console.log(' 这是一个相对链接');
    } 
})

// 添加style到head中
$('head').append(`
<style>
/* 自定义右键菜单样式 */
        .custom-contextmenu {
            position: fixed;
            background: #fff;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            border-radius: 4px;
            padding: 8px 0;
            display: none;
            z-index: 1000;
        }
        .custom-contextmenu-item {
            padding: 8px 24px;
            cursor: pointer;
            white-space: nowrap;
            user-select: none;
        }
        .custom-contextmenu-item:hover {
            background: #f5f5f5;
        }
</style>
`);

// 右键菜单模板
const menuTemplate = `
<div class="custom-contextmenu">
    <a href="javascript:;" class="custom-contextmenu-item" data-action="open-new-tab" target="_blank">在新标签页中打开链接</a>
</div>
`;

// 右键事件处理
$('.message').on('contextmenu', 'a', function(e) {
    $('.custom-contextmenu').remove();
    e.preventDefault(); // 阻止原生右键菜单
    const $link = $(this);
    // 渲染自定义菜单
    const $menu = $(menuTemplate).css({
        left: e.clientX,
        top: e.clientY
    }).appendTo('body');
    // 给custom-contextmenu-item添加链接
    $menu.find('.custom-contextmenu-item').attr('href', $link.attr('href'));
    // 显示菜单
    $menu.show();
    $menu.find('[data-action="open-new-tab"]').on('contextmenu', function(e) {
        e.preventDefault(); // 阻止原生右键菜单
        $menu.remove(); // 移除菜单
    })
    // 新标签页打开逻辑（带自定义行为）
    $menu.find('[data-action="open-new-tab"]').click(function(event) {
        $menu.remove();
        const url = new URL(this.href);
        if (url.protocol  === 'http:' || url.protocol  === 'https:') {
            // 获取当前域名
            var currentDomain = window.location.hostname;
            // 获取链接地址
            var href = this.href;
            // 判断是否为第三方链接
            if (href.indexOf(getMainDomain(currentDomain))  === -1) {
                console.log(' 是第三方链接');
                // 第三方白名单判断
                if (isThirdPartyLink(href)) {
                    // console.log(' 是白名单链接');
                    return;
                }
                // 阻止默认行为
                event.preventDefault();
                var targetUrl = href; 
                window.open('link.htm?url='  + encodeURIComponent(targetUrl), '_blank');
                
            } else {
                // console.log(' 不是一个第三方');
                let href_ = $(this).attr('href');
                // 判断href_是否包含elink@，如果包含，则移除elink@并返回新字符串
                if (href_.indexOf('elink@') !== -1) {
                    event.preventDefault();
                    href_ = href_.replace('elink@', '');
                    let decodedContent = xn.urldecode(kx_url_decrypt(href_));
                    
                    window.open(decodedContent, '_blank');
                    return;
                }
                if(handleLinkClick(this.href)) {
                    event.preventDefault(); 
                    var targetUrl = this.href; 
                    window.open('link.htm?url='  + encodeURIComponent(targetUrl), '_blank');
                    return;
                }
            }
        } else { 
            console.log(' 这是一个相对链接');
        } 

    });
    // 点击外部关闭菜单
    $(document).one('click', function closeMenu() {
        $menu.remove();
        $(document).off('click', closeMenu);
    });
});

$(document).on("scroll", function () {
    // 当滚动条滚动时，移除所有的custom-contextmenu
    $(".custom-contextmenu").remove();
})

