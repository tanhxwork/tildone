/*
 * Tildone motion — drop-in web component
 * ---------------------------------------
 * <script src="tildone-motion.js"></script>
 * <tildone-mark variant="til-done"></tildone-mark>
 *
 * variant : wave | tilde-dot | til-done | clock | dot-loader | drop-in   (default: wave)
 * scale   : number, multiplies the native size (default: 1)
 *
 * Framework-agnostic. Styles + fonts are encapsulated in shadow DOM, so it
 * never collides with your app's CSS. Loads Inter itself, but if your app
 * already ships Inter it'll use that.
 */
(function () {
  var FONT = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');";

  var KEYFRAMES = `
  @keyframes tld-draw{0%{stroke-dashoffset:1}32%{stroke-dashoffset:0}80%{stroke-dashoffset:0}100%{stroke-dashoffset:-1}}
  @keyframes tld-dot{0%{stroke-dashoffset:1}38%{stroke-dashoffset:0}80%{stroke-dashoffset:0}100%{stroke-dashoffset:-1}}
  @keyframes tld-bob{0%{transform:translateX(-50%) translateY(-2px)}38%{transform:translateX(-50%) translateY(0)}100%{transform:translateX(-50%) translateY(0)}}
  @keyframes tld-markpop{0%,30%{transform:scale(1)}37%{transform:scale(1.15)}45%{transform:scale(.975)}53%{transform:scale(1)}100%{transform:scale(1)}}
  @keyframes tld-spark{0%,32%{opacity:0;transform:scale(0) rotate(-40deg)}45%{opacity:1;transform:scale(1) rotate(15deg)}62%{opacity:0;transform:scale(1.45) rotate(55deg)}100%{opacity:0;transform:scale(1.45)}}
  @keyframes s-til{0%{opacity:0;transform:translate(0,7px)}5%{opacity:1;transform:translate(0,0)}68%{opacity:1;transform:translate(0,0)}71%{transform:translate(-7px,0)}76%{transform:translate(2px,0)}80%{transform:translate(0,0)}94%{opacity:1;transform:translate(0,0)}100%{opacity:0;transform:translate(0,0)}}
  @keyframes s-dot1{0%,10%{opacity:0}14%{opacity:1}42%{opacity:1}46%{opacity:0}100%{opacity:0}}
  @keyframes s-dot2{0%,16%{opacity:0}20%{opacity:1}42%{opacity:1}46%{opacity:0}100%{opacity:0}}
  @keyframes s-dot3{0%,22%{opacity:0}26%{opacity:1}42%{opacity:1}46%{opacity:0}100%{opacity:0}}
  @keyframes s-mfade{0%,42%{opacity:0}46%{opacity:1}96%{opacity:1}100%{opacity:0}}
  @keyframes s-fly{0%,69%{transform:translate(54px,43px) scale(1.25)}74%{transform:translate(-30px,38px) scale(1.15)}79%{transform:translate(-40px,-2px) scale(1.05)}83%{transform:translate(-6px,-14px) scale(1)}87%{transform:translate(0,0) scale(1)}100%{transform:translate(0,0) scale(1)}}
  @keyframes s-done{0%,58%{opacity:0;transform:translateX(52px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}63%{opacity:1;transform:translateX(40px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}69%{opacity:1;transform:translateX(-20px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}72%{transform:translateX(-20px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}76%{transform:translateX(-2px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}80%{transform:translateX(-9px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}88%{-webkit-text-fill-color:#3f9868}93%{-webkit-text-fill-color:#37352f}97%{opacity:1;transform:translateX(-9px);-webkit-text-fill-color:#37352f}100%{opacity:0;transform:translateX(-9px);-webkit-text-fill-color:#37352f}}
  @keyframes s2-dot1{0%,7%{opacity:0}11%{opacity:1}30%{opacity:1}34%{opacity:0}100%{opacity:0}}
  @keyframes s2-dot2{0%,13%{opacity:0}17%{opacity:1}30%{opacity:1}34%{opacity:0}100%{opacity:0}}
  @keyframes s2-dot3{0%,19%{opacity:0}23%{opacity:1}30%{opacity:1}34%{opacity:0}100%{opacity:0}}
  @keyframes s2-clock{0%,30%{opacity:0;transform:scale(.55)}35%{opacity:1;transform:scale(1)}70%{opacity:1;transform:scale(1)}75%{opacity:0;transform:scale(1.15)}100%{opacity:0;transform:scale(1.15)}}
  @keyframes s2-mfade{0%,69%{opacity:0}72%{opacity:1}96%{opacity:1}100%{opacity:0}}
  @keyframes s2-fly{0%,71%{transform:translate(54px,43px) scale(1.25)}75%{transform:translate(-28px,38px) scale(1.15)}80%{transform:translate(-40px,-2px) scale(1.05)}84%{transform:translate(-6px,-14px) scale(1)}88%{transform:translate(0,0) scale(1)}100%{transform:translate(0,0) scale(1)}}
  @keyframes s2-done{0%,60%{opacity:0;transform:translateX(52px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}65%{opacity:1;transform:translateX(40px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}71%{opacity:1;transform:translateX(-20px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}74%{transform:translateX(-20px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}78%{transform:translateX(-2px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}82%{transform:translateX(-9px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}89%{-webkit-text-fill-color:#3f9868}94%{-webkit-text-fill-color:#37352f}98%{opacity:1;transform:translateX(-9px);-webkit-text-fill-color:#37352f}100%{opacity:0;transform:translateX(-9px);-webkit-text-fill-color:#37352f}}
  @keyframes s3-til{0%{opacity:0;transform:translate(0,7px)}4%{opacity:1;transform:translate(0,0)}73%{transform:translate(0,0)}76%{transform:translate(-7px,0)}80%{transform:translate(2px,0)}84%{transform:translate(0,0)}96%{opacity:1;transform:translate(0,0)}100%{opacity:0;transform:translate(0,0)}}
  @keyframes s3-dotenv{0%,7%{opacity:0}12%{opacity:1}50%{opacity:1}54%{opacity:0}100%{opacity:0}}
  @keyframes s3-bounce{0%,70%,100%{transform:translateY(0)}35%{transform:translateY(-8px)}}
  @keyframes s3-mfade{0%,50%{opacity:0}54%{opacity:1}97%{opacity:1}100%{opacity:0}}
  @keyframes s3-fly{0%,74%{transform:translate(54px,43px) scale(1.25)}78%{transform:translate(-30px,38px) scale(1.15)}83%{transform:translate(-40px,-2px) scale(1.05)}87%{transform:translate(-6px,-14px) scale(1)}90%{transform:translate(0,0) scale(1)}100%{transform:translate(0,0) scale(1)}}
  @keyframes s3-done{0%,64%{opacity:0;transform:translateX(52px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}69%{opacity:1;transform:translateX(40px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}74%{opacity:1;transform:translateX(-20px);-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f}77%{transform:translateX(-20px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}81%{transform:translateX(-2px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}85%{transform:translateX(-9px);-webkit-text-fill-color:#3f9868;-webkit-text-stroke:0px #3f9868}91%{-webkit-text-fill-color:#3f9868}95%{-webkit-text-fill-color:#37352f}98%{opacity:1;transform:translateX(-9px);-webkit-text-fill-color:#37352f}100%{opacity:0;transform:translateX(-9px);-webkit-text-fill-color:#37352f}}
  @keyframes s4-til{0%{opacity:0;transform:translate(0,7px)}4%{opacity:1;transform:translate(0,0)}92%{transform:translate(0,0)}94%{transform:translate(0,3px)}96%{transform:translate(0,0)}98%{opacity:1;transform:translate(0,0)}100%{opacity:0;transform:translate(0,0)}}
  @keyframes s4-dn{0%,59%{opacity:0;transform:translateY(-80px)}63%{opacity:1;transform:translateY(-80px)}69%{opacity:1;transform:translateY(6px)}72%{transform:translateY(0)}98%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(0)}}
  @keyframes s4-o{0%,59%{opacity:0;transform:translateY(-140px)}62%{opacity:1;transform:translateY(-140px)}67%{transform:translateY(-54px)}68.5%{transform:translateY(-49px)}70%{transform:translateY(-54px)}72.5%{transform:translateY(-54px)}75%{transform:translateY(-33px)}77.5%{transform:translateY(-36px)}80%{transform:translateY(-36px)}82%{transform:translateY(-52px)}83.5%{transform:translateY(-22px)}86%{transform:translateY(0)}98%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(0)}}
  `;

  var WORDMARK = "position:relative;width:300px;height:96px;font-family:'Inter',-apple-system,sans-serif;font-weight:800;font-size:52px;letter-spacing:-.03em;line-height:1;color:#37352f;";

  var VARIANTS = {
    'wave': { w: 120, h: 120, html:
      '<svg width="120" height="120" viewBox="0 0 120 120" fill="none" style="display:block;">' +
        '<path d="M16,60 C24,45 35,45 45,57 C51,64 57,65 64,58 C71,52 76,58 80,73 L108,33" stroke="#5645d4" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" pathLength="1" style="stroke-dasharray:1;transform-box:fill-box;transform-origin:center;animation:tld-draw 2.8s ease-in-out infinite,tld-markpop 2.8s ease-in-out infinite"/>' +
        '<g transform="translate(94,17)"><path d="M0,-7 C1,-2 2,-1 7,0 C2,1 1,2 0,7 C-1,2 -2,1 -7,0 C-2,-1 -1,-2 0,-7 Z" fill="#5645d4" style="transform-box:fill-box;transform-origin:center;animation:tld-spark 2.8s ease-in-out infinite"/></g>' +
        '<g transform="translate(113,47)"><path d="M0,-5 C.7,-1.4 1.4,-.7 5,0 C1.4,.7 .7,1.4 0,5 C-.7,1.4 -1.4,.7 -5,0 C-1.4,-.7 -.7,-1.4 0,-5 Z" fill="#9386ec" style="transform-box:fill-box;transform-origin:center;animation:tld-spark 2.8s ease-in-out infinite;animation-delay:.12s"/></g>' +
      '</svg>' },

    'tilde-dot': { w: 214, h: 70, html:
      '<div style="width:214px;height:70px;display:flex;align-items:center;justify-content:center;color:#37352f;">' +
        '<div style="display:flex;align-items:flex-end;font-family:\'Inter\',-apple-system,sans-serif;font-size:46px;font-weight:800;letter-spacing:-.03em;line-height:1;">' +
          '<span>t</span><span style="position:relative;">ı<svg width="24" height="12" viewBox="0 0 40 18" fill="none" style="position:absolute;left:50%;top:-13px;animation:tld-bob 2.8s ease-in-out infinite"><path d="M4,11 C10,3 16,3 21,9 C25,14 31,14 36,7" stroke="#5645d4" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" pathLength="1" style="stroke-dasharray:1;animation:tld-dot 2.8s ease-in-out infinite"/></svg></span><span>ldone</span>' +
        '</div>' +
      '</div>' },

    'til-done': { w: 300, h: 96, html:
      '<div style="' + WORDMARK + '">' +
        '<div style="position:absolute;left:44px;top:24px;animation:s-til 5.6s ease-in-out infinite;">tıl</div>' +
        '<div style="position:absolute;left:104px;top:60px;display:flex;gap:11px;">' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;transform-origin:center;animation:s-dot1 5.6s ease-in-out infinite;"></span>' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;transform-origin:center;animation:s-dot2 5.6s ease-in-out infinite;"></span>' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;transform-origin:center;animation:s-dot3 5.6s ease-in-out infinite;"></span>' +
        '</div>' +
        '<svg width="40" height="24" viewBox="0 0 44 26" fill="none" style="position:absolute;left:55px;top:5px;transform-box:fill-box;transform-origin:center;animation:s-fly 5.6s ease-in-out infinite,s-mfade 5.6s ease-in-out infinite;"><path d="M6,15 C11,15 16,15 21,15 C26,15 31,15 37,15" stroke="#a4a097" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><animate attributeName="d" dur="5.6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.44;0.50;0.56;0.62;0.68;0.86;1" values="M6,15 C11,15 16,15 21,15 C26,15 31,15 37,15;M6,15 C11,15 16,15 21,15 C26,15 31,15 37,15;M9,4 C9,10 9,15 9,20 C15,20 22,20 28,20;M9,4 C9,10 9,15 9,20 C15,20 22,20 28,20;M8,12 C10,14 13,16 16,20 C23,14 29,9 36,3;M8,12 C10,14 13,16 16,20 C23,14 29,9 36,3;M6,15 C11,8 16,8 21,13 C26,18 31,18 37,11;M6,15 C11,8 16,8 21,13 C26,18 31,18 37,11" keySplines="0 0 1 1;.34 0 .5 1;0 0 1 1;.34 0 .66 1;0 0 1 1;.4 0 .5 1;0 0 1 1"/><animate attributeName="stroke" dur="5.6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.50;0.66;0.70;0.84;1" values="#a4a097;#a4a097;#3f9868;#3f9868;#5645d4;#5645d4" keySplines="0 0 1 1;.4 0 .6 1;0 0 1 1;.4 0 .6 1;0 0 1 1"/><animateTransform attributeName="transform" type="rotate" dur="5.6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.62;0.633;0.647;0.66;0.68;0.87;1" values="0 20 13;0 20 13;-14 20 13;12 20 13;-6 20 13;0 20 13;-360 20 13;-360 20 13" keySplines="0 0 1 1;.3 0 .4 1;.3 0 .4 1;.3 0 .4 1;.3 0 .4 1;.45 0 .55 1;0 0 1 1"/></path></svg>' +
        '<div style="position:absolute;left:98px;top:24px;-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f;transform-origin:left center;animation:s-done 5.6s ease-in-out infinite;">done</div>' +
      '</div>' },

    'clock': { w: 300, h: 96, html:
      '<div style="' + WORDMARK + '">' +
        '<div style="position:absolute;left:44px;top:24px;animation:s-til 6s ease-in-out infinite;">tıl</div>' +
        '<div style="position:absolute;left:104px;top:60px;display:flex;gap:11px;">' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;animation:s2-dot1 6s ease-in-out infinite;"></span>' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;animation:s2-dot2 6s ease-in-out infinite;"></span>' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;animation:s2-dot3 6s ease-in-out infinite;"></span>' +
        '</div>' +
        '<svg width="60" height="60" viewBox="0 0 60 60" fill="none" style="position:absolute;left:104px;top:24px;transform-box:fill-box;transform-origin:center;animation:s2-clock 6s ease-in-out infinite;">' +
          '<circle cx="30" cy="30" r="25" stroke="#a4a097" stroke-width="4"><animate attributeName="opacity" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.58;0.66;1" values="1;1;0;0" keySplines="0 0 1 1;.4 0 .6 1;0 0 1 1"/></circle>' +
          '<line x1="30" y1="30" x2="30" y2="15" stroke="#dfa63a" stroke-width="4.5" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.34;0.60;0.635;0.65;0.665;0.68;0.69;1" values="0 30 30;0 30 30;600 30 30;680 30 30;672 30 30;687 30 30;677 30 30;680 30 30;680 30 30" keySplines="0 0 1 1;0 0 1 1;.3 0 0 1;.25 0 .4 1;.3 0 .4 1;.3 0 .4 1;.3 0 .4 1;0 0 1 1"/><animate attributeName="stroke" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.60;0.635;0.665;1" values="#dfa63a;#dfa63a;#dfa63a;#3f9868;#3f9868" keySplines="0 0 1 1;0 0 1 1;.4 0 .6 1;0 0 1 1"/></line>' +
          '<line x1="30" y1="30" x2="30" y2="9" stroke="#dfa63a" stroke-width="3.5" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.34;0.60;0.635;0.65;0.665;0.68;0.69;1" values="0 30 30;0 30 30;720 30 30;760 30 30;752 30 30;767 30 30;757 30 30;760 30 30;760 30 30" keySplines="0 0 1 1;0 0 1 1;.3 0 0 1;.25 0 .4 1;.3 0 .4 1;.3 0 .4 1;.3 0 .4 1;0 0 1 1"/><animate attributeName="stroke" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.60;0.635;0.665;1" values="#dfa63a;#dfa63a;#dfa63a;#3f9868;#3f9868" keySplines="0 0 1 1;0 0 1 1;.4 0 .6 1;0 0 1 1"/></line>' +
          '<circle cx="30" cy="30" r="3" fill="#dfa63a"><animate attributeName="opacity" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.58;0.66;1" values="1;1;0;0" keySplines="0 0 1 1;.4 0 .6 1;0 0 1 1"/></circle>' +
        '</svg>' +
        '<svg width="40" height="24" viewBox="0 0 44 26" fill="none" style="position:absolute;left:55px;top:5px;transform-box:fill-box;transform-origin:center;animation:s2-fly 6s ease-in-out infinite,s2-mfade 6s ease-in-out infinite;"><path d="M8,12 C10,14 13,16 16,20 C23,14 29,9 36,3" stroke="#3f9868" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><animate attributeName="d" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.71;0.88;1" values="M8,12 C10,14 13,16 16,20 C23,14 29,9 36,3;M8,12 C10,14 13,16 16,20 C23,14 29,9 36,3;M6,15 C11,8 16,8 21,13 C26,18 31,18 37,11;M6,15 C11,8 16,8 21,13 C26,18 31,18 37,11" keySplines="0 0 1 1;.4 0 .5 1;0 0 1 1"/><animate attributeName="stroke" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.74;0.88;1" values="#3f9868;#3f9868;#5645d4;#5645d4" keySplines="0 0 1 1;.4 0 .6 1;0 0 1 1"/><animateTransform attributeName="transform" type="rotate" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.71;0.88;1" values="0 20 13;0 20 13;-360 20 13;-360 20 13" keySplines="0 0 1 1;.45 0 .55 1;0 0 1 1"/></path></svg>' +
        '<div style="position:absolute;left:98px;top:24px;-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f;transform-origin:left center;animation:s2-done 6s ease-in-out infinite;">done</div>' +
      '</div>' },

    'dot-loader': { w: 300, h: 96, html:
      '<div style="' + WORDMARK + '">' +
        '<div style="position:absolute;left:44px;top:24px;animation:s3-til 7s ease-in-out infinite;">tıl</div>' +
        '<div style="position:absolute;left:104px;top:60px;display:flex;gap:11px;">' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;transform-origin:center;animation:s3-dotenv 7s ease-in-out infinite,s3-bounce .9s ease-in-out infinite;animation-delay:0s,0s;"></span>' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;transform-origin:center;animation:s3-dotenv 7s ease-in-out infinite,s3-bounce .9s ease-in-out infinite;animation-delay:0s,.15s;"></span>' +
          '<span style="width:9px;height:9px;border-radius:50%;background:#a4a097;transform-origin:center;animation:s3-dotenv 7s ease-in-out infinite,s3-bounce .9s ease-in-out infinite;animation-delay:0s,.3s;"></span>' +
        '</div>' +
        '<svg width="40" height="24" viewBox="0 0 44 26" fill="none" style="position:absolute;left:55px;top:5px;transform-box:fill-box;transform-origin:center;animation:s3-fly 7s ease-in-out infinite,s3-mfade 7s ease-in-out infinite;"><path d="M6,15 C11,15 16,15 21,15 C26,15 31,15 37,15" stroke="#a4a097" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><animate attributeName="d" dur="7s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.52;0.57;0.63;0.68;0.73;0.87;1" values="M6,15 C11,15 16,15 21,15 C26,15 31,15 37,15;M6,15 C11,15 16,15 21,15 C26,15 31,15 37,15;M9,4 C9,10 9,15 9,20 C15,20 22,20 28,20;M9,4 C9,10 9,15 9,20 C15,20 22,20 28,20;M8,12 C10,14 13,16 16,20 C23,14 29,9 36,3;M8,12 C10,14 13,16 16,20 C23,14 29,9 36,3;M6,15 C11,8 16,8 21,13 C26,18 31,18 37,11;M6,15 C11,8 16,8 21,13 C26,18 31,18 37,11" keySplines="0 0 1 1;.34 0 .5 1;0 0 1 1;.34 0 .66 1;0 0 1 1;.4 0 .5 1;0 0 1 1"/><animate attributeName="stroke" dur="7s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.56;0.70;0.74;0.87;1" values="#a4a097;#a4a097;#3f9868;#3f9868;#5645d4;#5645d4" keySplines="0 0 1 1;.4 0 .6 1;0 0 1 1;.4 0 .6 1;0 0 1 1"/><animateTransform attributeName="transform" type="rotate" dur="7s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.68;0.693;0.707;0.72;0.74;0.87;1" values="0 20 13;0 20 13;-14 20 13;12 20 13;-6 20 13;0 20 13;-360 20 13;-360 20 13" keySplines="0 0 1 1;.3 0 .4 1;.3 0 .4 1;.3 0 .4 1;.3 0 .4 1;.45 0 .55 1;0 0 1 1"/></path></svg>' +
        '<div style="position:absolute;left:98px;top:24px;-webkit-text-fill-color:#ffffff;-webkit-text-stroke:1.6px #37352f;transform-origin:left center;animation:s3-done 7s ease-in-out infinite;">done</div>' +
      '</div>' },

    'drop-in': { w: 300, h: 96, html:
      '<div style="' + WORDMARK + 'overflow:visible;">' +
        '<div style="position:absolute;left:44px;top:24px;animation:s4-til 7.5s ease-in-out infinite;">tıl</div>' +
        '<svg width="300" height="96" viewBox="0 0 300 96" fill="none" style="position:absolute;left:0;top:0;overflow:visible;pointer-events:none;">' +
          '<circle r="4.5" fill="#a4a097" opacity="0"><animate attributeName="opacity" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.02;0.06;0.13;0.16;1" values="0;0;1;1;0;0"/><animate attributeName="cx" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.04;0.12;1" values="110;110;130;130" keySplines="0 0 1 1;.4 0 .3 1;0 0 1 1"/><animate attributeName="cy" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.04;0.12;1" values="64;64;48;48"/></circle>' +
          '<circle r="4.5" fill="#a4a097" opacity="0"><animate attributeName="opacity" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.04;0.08;0.13;0.16;1" values="0;0;1;1;0;0"/><animate attributeName="cy" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.04;0.12;1" values="64;64;48;48" keySplines="0 0 1 1;.4 0 .3 1;0 0 1 1"/><animate attributeName="cx" dur="7.5s" repeatCount="indefinite" keyTimes="0;1" values="130;130"/></circle>' +
          '<circle r="4.5" fill="#a4a097" opacity="0"><animate attributeName="opacity" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.06;0.10;0.13;0.16;1" values="0;0;1;1;0;0"/><animate attributeName="cx" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.04;0.12;1" values="150;150;130;130" keySplines="0 0 1 1;.4 0 .3 1;0 0 1 1"/><animate attributeName="cy" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.04;0.12;1" values="64;64;48;48"/></circle>' +
          '<circle cx="130" cy="48" r="22" fill="none" stroke="#a4a097" stroke-width="4" stroke-linecap="round" stroke-dasharray="138.23" stroke-dashoffset="138.23" opacity="0" transform="rotate(-90 130 48)"><animate attributeName="opacity" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.11;0.16;0.50;0.56;1" values="0;0;1;1;0;0"/><animate attributeName="stroke-dashoffset" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.12;0.24;1" values="138.23;138.23;0;0" keySplines="0 0 1 1;.3 0 .4 1;0 0 1 1"/></circle>' +
          '<circle cx="130" cy="48" r="3.5" fill="#dfa63a" opacity="0"><animate attributeName="opacity" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.13;0.18;0.52;0.57;1" values="0;0;1;1;0;0"/></circle>' +
          '<line x1="130" y1="48" x2="130" y2="34" stroke="#dfa63a" stroke-width="4" stroke-linecap="round" opacity="0"><animate attributeName="opacity" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.15;0.19;0.50;0.545;1" values="0;0;1;1;0;0"/><animateTransform attributeName="transform" type="rotate" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.19;0.50;1" values="0 130 48;0 130 48;1440 130 48;1440 130 48" keySplines="0 0 1 1;.2 0 .35 1;0 0 1 1"/></line>' +
          '<path fill="none" stroke="#dfa63a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0" d="M130,48 C130,48 130,48 130,48 C130,48 130,48 130,48"><animate attributeName="opacity" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.14;0.18;0.862;0.87;0.90;1" values="0;0;1;1;0;1;1"/><animate attributeName="d" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.10;0.16;0.50;0.545;0.60;0.94;0.97;1" values="M130,48 C130,48 130,48 130,48 C130,48 130,48 130,48;M130,48 C130,48 130,48 130,48 C130,48 130,48 130,48;M130,48 C130,44 130,40 130,36 C130,32 130,28 130,24;M130,48 C130,44 130,40 130,36 C130,32 130,28 130,24;M116,49 C120,52 124,56 127,60 C135,50 144,40 153,30;M118,50 C121,53 124,56 127,59 C134,51 141,43 149,36;M118,50 C121,53 124,56 127,59 C134,51 141,43 149,36;M118,50 C124,42 130,42 134,48 C139,54 145,54 150,44;M118,50 C124,42 130,42 134,48 C139,54 145,54 150,44" keySplines="0 0 1 1;.3 0 .3 1;0 0 1 1;.4 0 .5 1;.3 0 .3 1;0 0 1 1;.4 0 .3 1;0 0 1 1"/><animateTransform attributeName="transform" type="rotate" additive="sum" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.16;0.50;0.51;1" values="0 130 48;0 130 48;720 130 48;720 130 48;720 130 48" keySplines="0 0 1 1;.2 0 .35 1;0 0 1 1;0 0 1 1"/><animateTransform attributeName="transform" type="translate" additive="sum" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.56;0.59;0.65;0.675;0.70;0.72;0.75;0.775;0.815;0.83;0.845;0.862;0.87;0.94;0.962;1" values="0,0;0,0;0,-18;0,-18;1,-13;0,-18;0,-18;0,3;0,0;0,0;2,7;10,30;40,110;-59,-140;-59,-34;-59,-41;-59,-34" keySplines="0 0 1 1;.3 0 .5 1;0 0 1 1;.3 0 .5 1;.3 0 .5 1;0 0 1 1;.4 0 1 1;.3 0 .5 1;0 0 1 1;.3 0 .6 1;.4 0 .7 1;.3 0 1 1;0 0 1 1;.4 0 .9 1;.3 0 .5 1;0 0 1 1"/><animateTransform attributeName="transform" type="rotate" additive="sum" dur="7.5s" repeatCount="indefinite" keyTimes="0;0.815;0.845;0.862;0.87;1" values="0 134 48;0 134 48;-14 134 48;85 134 48;0 134 48;0 134 48"/><animate attributeName="stroke" dur="7.5s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.50;0.57;0.94;0.97;1" values="#dfa63a;#dfa63a;#3f9868;#3f9868;#5645d4;#5645d4" keySplines="0 0 1 1;.4 0 .6 1;0 0 1 1;.4 0 .6 1;0 0 1 1"/></path>' +
        '</svg>' +
        '<div style="position:absolute;left:89px;top:24px;animation:s4-dn 7.5s ease-in-out infinite;">d</div>' +
        '<div style="position:absolute;left:150px;top:24px;animation:s4-dn 7.5s ease-in-out infinite;">ne</div>' +
        '<div style="position:absolute;left:120px;top:24px;transform-origin:center;animation:s4-o 7.5s ease-in-out infinite;">o</div>' +
      '</div>' }
  };

  var ALIASES = { '2a': 'wave', '2c': 'tilde-dot', '3a': 'til-done', '3b': 'clock', '3c': 'dot-loader', '3d': 'drop-in' };

  class TildoneMark extends HTMLElement {
    static get observedAttributes() { return ['variant', 'scale']; }
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this._render();
    }
    attributeChangedCallback() {
      if (this.shadowRoot) this._render();
    }
    _render() {
      var key = (this.getAttribute('variant') || 'wave').toLowerCase();
      key = ALIASES[key] || key;
      var def = VARIANTS[key] || VARIANTS.wave;
      var scale = parseFloat(this.getAttribute('scale')) || 1;
      var W = def.w * scale, H = def.h * scale;
      this.shadowRoot.innerHTML =
        '<style>' + FONT +
        ':host{display:inline-block;width:' + W + 'px;height:' + H + 'px;line-height:0;vertical-align:middle;}' +
        '.stage{width:' + def.w + 'px;height:' + def.h + 'px;transform:scale(' + scale + ');transform-origin:top left;}' +
        KEYFRAMES + '</style>' +
        '<div class="stage">' + def.html + '</div>';
    }
  }

  if (!customElements.get('tildone-mark')) customElements.define('tildone-mark', TildoneMark);
})();
