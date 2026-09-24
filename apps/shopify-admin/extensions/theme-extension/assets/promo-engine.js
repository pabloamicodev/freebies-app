"use strict";var PromoEngine=(()=>{var _e=Object.defineProperty;var kt=Object.getOwnPropertyDescriptor;var Et=Object.getOwnPropertyNames;var Tt=Object.prototype.hasOwnProperty;var Pt=(t,e)=>{for(var r in e)_e(t,r,{get:e[r],enumerable:!0})},At=(t,e,r,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of Et(e))!Tt.call(t,i)&&i!==r&&_e(t,i,{get:()=>e[i],enumerable:!(n=kt(e,i))||n.enumerable});return t};var Rt=t=>At(_e({},"__esModule",{value:!0}),t);var dr={};Pt(dr,{AbortableRequest:()=>Q,AjaxCartAdapter:()=>L,PromoEvents:()=>v,StorefrontApiAdapter:()=>ge,debounce:()=>ee,emit:()=>I,initBundleBuilder:()=>Ct,initCartDrawerIntegration:()=>vt,initFbtWidget:()=>me,initGiftSlider:()=>fe,initTodayOfferWidget:()=>wt,on:()=>E,publishAnalytics:()=>T});var Ne=Promise.resolve();function $t(t){let e=t.split("/").pop()??t;if(!/^\d+$/.test(e))throw new Error("Invalid Shopify variant ID.");let r=Number(e);if(!Number.isSafeInteger(r)||r<=0)throw new Error("Invalid Shopify variant ID.");return r}function F(t){return new Promise((e,r)=>{Ne=Ne.then(t).then(e,r)})}async function z(t,e){let r=await fetch(t,{...e,headers:{"Content-Type":"application/json",Accept:"application/json",...e?.headers}});if(!r.ok){let n=await r.text();throw new Error(`Cart API error ${r.status}: ${n}`)}return r.json()}var L={async getCart(){return z(`${window.Shopify?.routes?.root??"/"}cart.js`)},async addLines(t){if(t.length===0)return this.getCart();if(t.length>250)throw new Error("Cannot add more than 250 cart lines at once.");return F(()=>z(`${window.Shopify?.routes?.root??"/"}cart/add.js`,{method:"POST",body:JSON.stringify({items:t.map(e=>({id:$t(e.variantId),quantity:Number.isSafeInteger(e.quantity)&&e.quantity>0?e.quantity:1,properties:e.properties}))})}))},async updateLine(t){return F(()=>z(`${window.Shopify?.routes?.root??"/"}cart/change.js`,{method:"POST",body:JSON.stringify({id:t.key,quantity:t.quantity,...t.properties?{properties:t.properties}:{}})}))},async removeLine(t){return F(()=>z(`${window.Shopify?.routes?.root??"/"}cart/change.js`,{method:"POST",body:JSON.stringify({id:t.key,quantity:0})}))},async removeLines(t){let e=[...new Set(t.flatMap(r=>r.key?[r.key]:[]))];return e.length===0?this.getCart():F(()=>z(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({updates:Object.fromEntries(e.map(r=>[r,0]))})}))},async applyDiscountCode(t){return F(()=>z(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({discount:t})}))},async removeDiscountCode(){return F(()=>z(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({discount:""})}))}};function ee(t,e){let r=null,n=null;function i(...d){n=d,r!==null&&clearTimeout(r),r=setTimeout(()=>{r=null,n&&t(...n)},e)}function o(){r!==null&&(clearTimeout(r),r=null)}function a(){o(),n&&t(...n)}return{call:i,cancel:o,flush:a}}var Q=class{controller=null;start(){return this.controller&&this.controller.abort("superseded"),this.controller=new AbortController,this.controller.signal}cancel(){this.controller&&(this.controller.abort("cancelled"),this.controller=null)}};var v={CartChanged:"promo-engine:cart-changed",EvaluationRequested:"promo-engine:evaluation-requested",EvaluationCompleted:"promo-engine:evaluation-completed",GiftAutoAdded:"promo-engine:gift-auto-added",GiftAdded:"promo-engine:gift-added",GiftUpdated:"promo-engine:gift-updated",GiftRemoved:"promo-engine:gift-removed",GiftSliderRequested:"promo-engine:gift-slider-requested",GiftSliderClosed:"promo-engine:gift-slider-closed",ProductChanged:"promo-engine:product-changed",CartMessageRender:"promo-engine:cart-message-render",ProgressRerender:"promo-engine:progress-rerender",TodayOfferRender:"promo-engine:today-offer-render",BundleInit:"promo-engine:bundle-init",UpsellInit:"promo-engine:upsell-init",CheckoutPrepare:"promo-engine:checkout-prepare",CartMutationError:"promo-engine:cart-mutation-error",InventoryFailure:"promo-engine:inventory-failure"};function I(t,e){window.dispatchEvent(new CustomEvent(t,{detail:e,bubbles:!0}))}function E(t,e,r){let n=i=>e(i.detail);return window.addEventListener(t,n,r),()=>window.removeEventListener(t,n)}function T(t,e){typeof window.Shopify?.analytics?.publish=="function"&&window.Shopify.analytics.publish(t,e)}function be(t,e,r){for(let n of t.items){if(n.variant_id!==e)continue;let i=n.properties??{};if(Object.entries(r).every(([a,d])=>i[a]===d))return n.key}return null}function ye(t,e){return t.items.find(r=>r.properties?._promo_engine_line_type==="gift"&&r.properties?._promo_engine_offer_id===e)??null}async function ve(){let t=await fetch(`${window.Shopify?.routes?.root??"/"}cart.js`,{headers:{Accept:"application/json"}});if(!t.ok)throw new Error(`Cart fetch failed: ${t.status}`);return t.json()}var le,C,Ve,Lt,G,ze,We,Ke,we,re,W,Ye,Se,xe,Ce,Dt,oe={},ae=[],qt=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,de=Array.isArray;function j(t,e){for(var r in e)t[r]=e[r];return t}function ke(t){t&&t.parentNode&&t.parentNode.removeChild(t)}function O(t,e,r){var n,i,o,a={};for(o in e)o=="key"?n=e[o]:o=="ref"?i=e[o]:a[o]=e[o];if(arguments.length>2&&(a.children=arguments.length>3?le.call(arguments,2):r),typeof t=="function"&&t.defaultProps!=null)for(o in t.defaultProps)a[o]===void 0&&(a[o]=t.defaultProps[o]);return ne(t,a,n,i,null)}function ne(t,e,r,n,i){var o={type:t,props:e,key:r,ref:n,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:i??++Ve,__i:-1,__u:0};return i==null&&C.vnode!=null&&C.vnode(o),o}function M(t){return t.children}function ie(t,e){this.props=t,this.context=e}function V(t,e){if(e==null)return t.__?V(t.__,t.__i+1):null;for(var r;e<t.__k.length;e++)if((r=t.__k[e])!=null&&r.__e!=null)return r.__e;return typeof t.type=="function"?V(t):null}function Mt(t){if(t.__P&&t.__d){var e=t.__v,r=e.__e,n=[],i=[],o=j({},e);o.__v=e.__v+1,C.vnode&&C.vnode(o),Ee(t.__P,o,e,t.__n,t.__P.namespaceURI,32&e.__u?[r]:null,n,r??V(e),!!(32&e.__u),i),o.__v=e.__v,o.__.__k[o.__i]=o,et(n,o,i),e.__e=e.__=null,o.__e!=r&&Je(o)}}function Je(t){if((t=t.__)!=null&&t.__c!=null)return t.__e=t.__c.base=null,t.__k.some(function(e){if(e!=null&&e.__e!=null)return t.__e=t.__c.base=e.__e}),Je(t)}function Be(t){(!t.__d&&(t.__d=!0)&&G.push(t)&&!se.__r++||ze!=C.debounceRendering)&&((ze=C.debounceRendering)||We)(se)}function se(){try{for(var t,e=1;G.length;)G.length>e&&G.sort(Ke),t=G.shift(),e=G.length,Mt(t)}finally{G.length=se.__r=0}}function Xe(t,e,r,n,i,o,a,d,u,l,p){var s,b,h,m,x,g,y,f=n&&n.__k||ae,S=e.length;for(u=Ot(r,e,f,u,S),s=0;s<S;s++)(h=r.__k[s])!=null&&(b=h.__i!=-1&&f[h.__i]||oe,h.__i=s,g=Ee(t,h,b,i,o,a,d,u,l,p),m=h.__e,h.ref&&b.ref!=h.ref&&(b.ref&&Te(b.ref,null,h),p.push(h.ref,h.__c||m,h)),x==null&&m!=null&&(x=m),(y=!!(4&h.__u))||b.__k===h.__k?(u=Ze(h,u,t,y),y&&b.__e&&(b.__e=null)):typeof h.type=="function"&&g!==void 0?u=g:m&&(u=m.nextSibling),h.__u&=-7);return r.__e=x,u}function Ot(t,e,r,n,i){var o,a,d,u,l,p=r.length,s=p,b=0;for(t.__k=new Array(i),o=0;o<i;o++)(a=e[o])!=null&&typeof a!="boolean"&&typeof a!="function"?(typeof a=="string"||typeof a=="number"||typeof a=="bigint"||a.constructor==String?a=t.__k[o]=ne(null,a,null,null,null):de(a)?a=t.__k[o]=ne(M,{children:a},null,null,null):a.constructor===void 0&&a.__b>0?a=t.__k[o]=ne(a.type,a.props,a.key,a.ref?a.ref:null,a.__v):t.__k[o]=a,u=o+b,a.__=t,a.__b=t.__b+1,d=null,(l=a.__i=Ut(a,r,u,s))!=-1&&(s--,(d=r[l])&&(d.__u|=2)),d==null||d.__v==null?(l==-1&&(i>p?b--:i<p&&b++),typeof a.type!="function"&&(a.__u|=4)):l!=u&&(l==u-1?b--:l==u+1?b++:(l>u?b--:b++,a.__u|=4))):t.__k[o]=null;if(s)for(o=0;o<p;o++)(d=r[o])!=null&&(2&d.__u)==0&&(d.__e==n&&(n=V(d)),rt(d,d));return n}function Ze(t,e,r,n){var i,o;if(typeof t.type=="function"){for(i=t.__k,o=0;i&&o<i.length;o++)i[o]&&(i[o].__=t,e=Ze(i[o],e,r,n));return e}t.__e!=e&&(n&&(e&&t.type&&!e.parentNode&&(e=V(t)),r.insertBefore(t.__e,e||null)),e=t.__e);do e=e&&e.nextSibling;while(e!=null&&e.nodeType==8);return e}function Ut(t,e,r,n){var i,o,a,d=t.key,u=t.type,l=e[r],p=l!=null&&(2&l.__u)==0;if(l===null&&d==null||p&&d==l.key&&u==l.type)return r;if(n>(p?1:0)){for(i=r-1,o=r+1;i>=0||o<e.length;)if((l=e[a=i>=0?i--:o++])!=null&&(2&l.__u)==0&&d==l.key&&u==l.type)return a}return-1}function Fe(t,e,r){e[0]=="-"?t.setProperty(e,r??""):t[e]=r==null?"":typeof r!="number"||qt.test(e)?r:r+"px"}function te(t,e,r,n,i){var o,a;e:if(e=="style")if(typeof r=="string")t.style.cssText=r;else{if(typeof n=="string"&&(t.style.cssText=n=""),n)for(e in n)r&&e in r||Fe(t.style,e,"");if(r)for(e in r)n&&r[e]==n[e]||Fe(t.style,e,r[e])}else if(e[0]=="o"&&e[1]=="n")o=e!=(e=e.replace(Ye,"$1")),a=e.toLowerCase(),e=a in t||e=="onFocusOut"||e=="onFocusIn"?a.slice(2):e.slice(2),t.l||(t.l={}),t.l[e+o]=r,r?n?r[W]=n[W]:(r[W]=Se,t.addEventListener(e,o?Ce:xe,o)):t.removeEventListener(e,o?Ce:xe,o);else{if(i=="http://www.w3.org/2000/svg")e=e.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(e!="width"&&e!="height"&&e!="href"&&e!="list"&&e!="form"&&e!="tabIndex"&&e!="download"&&e!="rowSpan"&&e!="colSpan"&&e!="role"&&e!="popover"&&e in t)try{t[e]=r??"";break e}catch{}typeof r=="function"||(r==null||r===!1&&e[4]!="-"?t.removeAttribute(e):t.setAttribute(e,e=="popover"&&r==1?"":r))}}function Qe(t){return function(e){if(this.l){var r=this.l[e.type+t];if(e[re]==null)e[re]=Se++;else if(e[re]<r[W])return;return r(C.event?C.event(e):e)}}}function Ee(t,e,r,n,i,o,a,d,u,l){var p,s,b,h,m,x,g,y,f,S,k,_,R,q,U,w=e.type;if(e.constructor!==void 0)return null;128&r.__u&&(u=!!(32&r.__u),o=[d=e.__e=r.__e]),(p=C.__b)&&p(e);e:if(typeof w=="function")try{if(y=e.props,f=w.prototype&&w.prototype.render,S=(p=w.contextType)&&n[p.__c],k=p?S?S.props.value:p.__:n,r.__c?g=(s=e.__c=r.__c).__=s.__E:(f?e.__c=s=new w(y,k):(e.__c=s=new ie(y,k),s.constructor=w,s.render=Ht),S&&S.sub(s),s.state||(s.state={}),s.__n=n,b=s.__d=!0,s.__h=[],s._sb=[]),f&&s.__s==null&&(s.__s=s.state),f&&w.getDerivedStateFromProps!=null&&(s.__s==s.state&&(s.__s=j({},s.__s)),j(s.__s,w.getDerivedStateFromProps(y,s.__s))),h=s.props,m=s.state,s.__v=e,b)f&&w.getDerivedStateFromProps==null&&s.componentWillMount!=null&&s.componentWillMount(),f&&s.componentDidMount!=null&&s.__h.push(s.componentDidMount);else{if(f&&w.getDerivedStateFromProps==null&&y!==h&&s.componentWillReceiveProps!=null&&s.componentWillReceiveProps(y,k),e.__v==r.__v||!s.__e&&s.shouldComponentUpdate!=null&&s.shouldComponentUpdate(y,s.__s,k)===!1){e.__v!=r.__v&&(s.props=y,s.state=s.__s,s.__d=!1),e.__e=r.__e,e.__k=r.__k,e.__k.some(function(P){P&&(P.__=e)}),ae.push.apply(s.__h,s._sb),s._sb=[],s.__h.length&&a.push(s);break e}s.componentWillUpdate!=null&&s.componentWillUpdate(y,s.__s,k),f&&s.componentDidUpdate!=null&&s.__h.push(function(){s.componentDidUpdate(h,m,x)})}if(s.context=k,s.props=y,s.__P=t,s.__e=!1,_=C.__r,R=0,f)s.state=s.__s,s.__d=!1,_&&_(e),p=s.render(s.props,s.state,s.context),ae.push.apply(s.__h,s._sb),s._sb=[];else do s.__d=!1,_&&_(e),p=s.render(s.props,s.state,s.context),s.state=s.__s;while(s.__d&&++R<25);s.state=s.__s,s.getChildContext!=null&&(n=j(j({},n),s.getChildContext())),f&&!b&&s.getSnapshotBeforeUpdate!=null&&(x=s.getSnapshotBeforeUpdate(h,m)),q=p!=null&&p.type===M&&p.key==null?tt(p.props.children):p,d=Xe(t,de(q)?q:[q],e,r,n,i,o,a,d,u,l),s.base=e.__e,e.__u&=-161,s.__h.length&&a.push(s),g&&(s.__E=s.__=null)}catch(P){if(e.__v=null,u||o!=null)if(P.then){for(e.__u|=u?160:128;d&&d.nodeType==8&&d.nextSibling;)d=d.nextSibling;o[o.indexOf(d)]=null,e.__e=d}else{for(U=o.length;U--;)ke(o[U]);Ie(e)}else e.__e=r.__e,e.__k=r.__k,P.then||Ie(e);C.__e(P,e,r)}else o==null&&e.__v==r.__v?(e.__k=r.__k,e.__e=r.__e):d=e.__e=jt(r.__e,e,r,n,i,o,a,u,l);return(p=C.diffed)&&p(e),128&e.__u?void 0:d}function Ie(t){t&&(t.__c&&(t.__c.__e=!0),t.__k&&t.__k.some(Ie))}function et(t,e,r){for(var n=0;n<r.length;n++)Te(r[n],r[++n],r[++n]);C.__c&&C.__c(e,t),t.some(function(i){try{t=i.__h,i.__h=[],t.some(function(o){o.call(i)})}catch(o){C.__e(o,i.__v)}})}function tt(t){return typeof t!="object"||t==null||t.__b>0?t:de(t)?t.map(tt):t.constructor!==void 0?null:j({},t)}function jt(t,e,r,n,i,o,a,d,u){var l,p,s,b,h,m,x,g=r.props||oe,y=e.props,f=e.type;if(f=="svg"?i="http://www.w3.org/2000/svg":f=="math"?i="http://www.w3.org/1998/Math/MathML":i||(i="http://www.w3.org/1999/xhtml"),o!=null){for(l=0;l<o.length;l++)if((h=o[l])&&"setAttribute"in h==!!f&&(f?h.localName==f:h.nodeType==3)){t=h,o[l]=null;break}}if(t==null){if(f==null)return document.createTextNode(y);t=document.createElementNS(i,f,y.is&&y),d&&(C.__m&&C.__m(e,o),d=!1),o=null}if(f==null)g===y||d&&t.data==y||(t.data=y);else{if(o=f=="textarea"&&y.defaultValue!=null?null:o&&le.call(t.childNodes),!d&&o!=null)for(g={},l=0;l<t.attributes.length;l++)g[(h=t.attributes[l]).name]=h.value;for(l in g)h=g[l],l=="dangerouslySetInnerHTML"?s=h:l=="children"||l in y||l=="value"&&"defaultValue"in y||l=="checked"&&"defaultChecked"in y||te(t,l,null,h,i);for(l in y)h=y[l],l=="children"?b=h:l=="dangerouslySetInnerHTML"?p=h:l=="value"?m=h:l=="checked"?x=h:d&&typeof h!="function"||g[l]===h||te(t,l,h,g[l],i);if(p)d||s&&(p.__html==s.__html||p.__html==t.innerHTML)||(t.innerHTML=p.__html),e.__k=[];else if(s&&(t.innerHTML=""),Xe(e.type=="template"?t.content:t,de(b)?b:[b],e,r,n,f=="foreignObject"?"http://www.w3.org/1999/xhtml":i,o,a,o?o[0]:r.__k&&V(r,0),d,u),o!=null)for(l=o.length;l--;)ke(o[l]);d&&f!="textarea"||(l="value",f=="progress"&&m==null?t.removeAttribute("value"):m!=null&&(m!==t[l]||f=="progress"&&!m||f=="option"&&m!=g[l])&&te(t,l,m,g[l],i),l="checked",x!=null&&x!=t[l]&&te(t,l,x,g[l],i))}return t}function Te(t,e,r){try{if(typeof t=="function"){var n=typeof t.__u=="function";n&&t.__u(),n&&e==null||(t.__u=t(e))}else t.current=e}catch(i){C.__e(i,r)}}function rt(t,e,r){var n,i;if(C.unmount&&C.unmount(t),(n=t.ref)&&(n.current&&n.current!=t.__e||Te(n,null,e)),(n=t.__c)!=null){if(n.componentWillUnmount)try{n.componentWillUnmount()}catch(o){C.__e(o,e)}n.base=n.__P=null}if(n=t.__k)for(i=0;i<n.length;i++)n[i]&&rt(n[i],e,r||typeof t.type!="function");r||ke(t.__e),t.__c=t.__=t.__e=void 0}function Ht(t,e,r){return this.constructor(t,r)}function H(t,e,r){var n,i,o,a;e==document&&(e=document.documentElement),C.__&&C.__(t,e),i=(n=typeof r=="function")?null:r&&r.__k||e.__k,o=[],a=[],Ee(e,t=(!n&&r||e).__k=O(M,null,[t]),i||oe,oe,e.namespaceURI,!n&&r?[r]:i?null:e.firstChild?le.call(e.childNodes):null,o,!n&&r?r:i?i.__e:e.firstChild,n,a),et(o,t,a)}le=ae.slice,C={__e:function(t,e,r,n){for(var i,o,a;e=e.__;)if((i=e.__c)&&!i.__)try{if((o=i.constructor)&&o.getDerivedStateFromError!=null&&(i.setState(o.getDerivedStateFromError(t)),a=i.__d),i.componentDidCatch!=null&&(i.componentDidCatch(t,n||{}),a=i.__d),a)return i.__E=i}catch(d){t=d}throw t}},Ve=0,Lt=function(t){return t!=null&&t.constructor===void 0},ie.prototype.setState=function(t,e){var r;r=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=j({},this.state),typeof t=="function"&&(t=t(j({},r),this.props)),t&&j(r,t),t!=null&&this.__v&&(e&&this._sb.push(e),Be(this))},ie.prototype.forceUpdate=function(t){this.__v&&(this.__e=!0,t&&this.__h.push(t),Be(this))},ie.prototype.render=M,G=[],We=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,Ke=function(t,e){return t.__v.__b-e.__v.__b},se.__r=0,we=Math.random().toString(8),re="__d"+we,W="__a"+we,Ye=/(PointerCapture)$|Capture$/i,Se=0,xe=Qe(!1),Ce=Qe(!0),Dt=0;var K,A,Pe,nt,ue=0,ut=[],$=C,it=$.__b,ot=$.__r,at=$.diffed,st=$.__c,lt=$.unmount,dt=$.__;function Re(t,e){$.__h&&$.__h(A,t,ue||e),ue=0;var r=A.__H||(A.__H={__:[],__h:[]});return t>=r.__.length&&r.__.push({}),r.__[t]}function D(t){return ue=1,Gt(ft,t)}function Gt(t,e,r){var n=Re(K++,2);if(n.t=t,!n.__c&&(n.__=[r?r(e):ft(void 0,e),function(d){var u=n.__N?n.__N[0]:n.__[0],l=n.t(u,d);u!==l&&(n.__N=[l,n.__[1]],n.__c.setState({}))}],n.__c=A,!A.__f)){var i=function(d,u,l){if(!n.__c.__H)return!0;var p=n.__c.__H.__.filter(function(b){return b.__c});if(p.every(function(b){return!b.__N}))return!o||o.call(this,d,u,l);var s=n.__c.props!==d;return p.some(function(b){if(b.__N){var h=b.__[0];b.__=b.__N,b.__N=void 0,h!==b.__[0]&&(s=!0)}}),o&&o.call(this,d,u,l)||s};A.__f=!0;var o=A.shouldComponentUpdate,a=A.componentWillUpdate;A.componentWillUpdate=function(d,u,l){if(this.__e){var p=o;o=void 0,i(d,u,l),o=p}a&&a.call(this,d,u,l)},A.shouldComponentUpdate=i}return n.__N||n.__}function pe(t,e){var r=Re(K++,3);!$.__s&&pt(r.__H,e)&&(r.__=t,r.u=e,A.__H.__h.push(r))}function Y(t){return ue=5,$e(function(){return{current:t}},[])}function $e(t,e){var r=Re(K++,7);return pt(r.__H,e)&&(r.__=t(),r.__H=e,r.__h=t),r.__}function Nt(){for(var t;t=ut.shift();){var e=t.__H;if(t.__P&&e)try{e.__h.some(ce),e.__h.some(Ae),e.__h=[]}catch(r){e.__h=[],$.__e(r,t.__v)}}}$.__b=function(t){A=null,it&&it(t)},$.__=function(t,e){t&&e.__k&&e.__k.__m&&(t.__m=e.__k.__m),dt&&dt(t,e)},$.__r=function(t){ot&&ot(t),K=0;var e=(A=t.__c).__H;e&&(Pe===A?(e.__h=[],A.__h=[],e.__.some(function(r){r.__N&&(r.__=r.__N),r.u=r.__N=void 0})):(e.__h.some(ce),e.__h.some(Ae),e.__h=[],K=0)),Pe=A},$.diffed=function(t){at&&at(t);var e=t.__c;e&&e.__H&&(e.__H.__h.length&&(ut.push(e)!==1&&nt===$.requestAnimationFrame||((nt=$.requestAnimationFrame)||zt)(Nt)),e.__H.__.some(function(r){r.u&&(r.__H=r.u),r.u=void 0})),Pe=A=null},$.__c=function(t,e){e.some(function(r){try{r.__h.some(ce),r.__h=r.__h.filter(function(n){return!n.__||Ae(n)})}catch(n){e.some(function(i){i.__h&&(i.__h=[])}),e=[],$.__e(n,r.__v)}}),st&&st(t,e)},$.unmount=function(t){lt&&lt(t);var e,r=t.__c;r&&r.__H&&(r.__H.__.some(function(n){try{ce(n)}catch(i){e=i}}),r.__H=void 0,e&&$.__e(e,r.__v))};var ct=typeof requestAnimationFrame=="function";function zt(t){var e,r=function(){clearTimeout(n),ct&&cancelAnimationFrame(e),setTimeout(t)},n=setTimeout(r,35);ct&&(e=requestAnimationFrame(r))}function ce(t){var e=A,r=t.__c;typeof r=="function"&&(t.__c=void 0,r()),A=e}function Ae(t){var e=A;t.__c=t.__(),A=e}function pt(t,e){return!t||t.length!==e.length||e.some(function(r,n){return r!==t[n]})}function ft(t,e){return typeof e=="function"?e(t):e}var Bt=0;function c(t,e,r,n,i,o){e||(e={});var a,d,u=e;if("ref"in u)for(d in u={},e)d=="ref"?a=e[d]:u[d]=e[d];var l={type:t,props:u,key:r,ref:a,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:--Bt,__i:-1,__u:0,__source:i,__self:o};if(typeof t=="function"&&(a=t.defaultProps))for(d in a)u[d]===void 0&&(u[d]=a[d]);return C.vnode&&C.vnode(l),l}var Ft=`
.pe-slider-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.4); border: 0; padding: 0;
  margin: 0; width: 100%; max-width: none; height: 100%; max-height: none;
  z-index: 9999; display: flex; align-items: flex-end; justify-content: center;
}
@media (min-width: 768px) {
  .pe-slider-overlay { align-items: center; }
}
.pe-slider-modal {
  background: #fff; border-radius: 12px 12px 0 0; width: 100%; max-width: 540px;
  max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 -4px 24px rgba(0,0,0,.15);
}
@media (min-width: 768px) {
  .pe-slider-modal { border-radius: 12px; max-height: 640px; }
}
.pe-slider-header {
  padding: 20px 20px 12px; border-bottom: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: flex-start;
}
.pe-slider-title { font-size: 18px; font-weight: 700; margin: 0; }
.pe-slider-subtitle { font-size: 13px; color: #6b7280; margin: 4px 0 0; }
.pe-slider-close {
  background: none; border: none; font-size: 20px; cursor: pointer;
  color: #6b7280; padding: 0; line-height: 1; min-width: 48px; min-height: 48px;
}
.pe-slider-body { overflow-y: auto; padding: 16px; flex: 1; }
.pe-gift-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@media (min-width: 480px) {
  .pe-gift-grid { grid-template-columns: repeat(3, 1fr); }
}
.pe-gift-card {
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 12px 10px;
  cursor: pointer; transition: border-color .15s, box-shadow .15s; position: relative;
  background: #fff; color: inherit; text-align: left; width: 100%; font: inherit;
}
.pe-gift-card:hover:not(.pe-unavailable) { border-color: #111; }
.pe-gift-card:focus-visible, .pe-slider-close:focus-visible, .pe-btn-confirm:focus-visible {
  outline: 3px solid #2563eb; outline-offset: 2px;
}
.pe-gift-card.pe-selected { border-color: #111; background: #f9f9f9; }
.pe-gift-card.pe-unavailable { opacity: .5; cursor: not-allowed; }
.pe-gift-check {
  position: absolute; top: 8px; right: 8px; width: 20px; height: 20px;
  background: #111; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; color: #fff; font-size: 12px;
}
.pe-gift-img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; background: #f3f4f6; }
.pe-gift-img-placeholder { width: 100%; aspect-ratio: 1; background: #f3f4f6; border-radius: 4px; }
.pe-gift-name { font-size: 13px; font-weight: 600; margin: 8px 0 2px; line-height: 1.3; }
.pe-gift-variant { font-size: 11px; color: #6b7280; margin: 0; }
.pe-gift-price { font-size: 12px; color: #6b7280; margin: 4px 0 0; }
.pe-gift-price s { opacity: .6; }
.pe-gift-free { color: #059669; font-weight: 700; }
.pe-gift-unavailable { color: #b42318; font-size: 11px; margin: 4px 0 0; }
.pe-slider-footer {
  padding: 14px 20px; border-top: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.pe-selected-count { font-size: 13px; color: #6b7280; }
.pe-btn-confirm {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; min-height: 48px; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background .15s; flex: 1;
}
.pe-btn-confirm:hover { background: #333; }
.pe-btn-confirm:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-slider-error { color: #b42318; font-size: 13px; margin: 0 20px 12px; }
.pe-loading { display: flex; align-items: center; justify-content: center; padding: 40px; }
.pe-spinner {
  width: 28px; height: 28px; border: 3px solid #e5e7eb;
  border-top-color: #111; border-radius: 50%; animation: pe-spin .7s linear infinite;
}
@keyframes pe-spin { to { transform: rotate(360deg); } }
.pe-sr-only {
  position: absolute; clip-path: inset(50%); overflow: hidden;
  width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .pe-gift-card, .pe-btn-confirm { transition: none; }
  .pe-spinner { animation: none; opacity: .65; }
}
`;function Qt(){if(document.getElementById("pe-slider-styles"))return;let t=document.createElement("style");t.id="pe-slider-styles",t.textContent=Ft,document.head.appendChild(t)}function mt(t,e){try{return new Intl.NumberFormat(navigator.language||"en-US",{style:"currency",currency:e}).format(t/100)}catch{return`${(t/100).toFixed(2)} ${e}`}}function N(t){return`${t.rewardId}:${t.variantId}`}function Vt({payload:t,sessionId:e,onClose:r,onConfirm:n}){let[i,o]=D(new Set(t.selectableGifts.filter(f=>f.isSelected).map(N))),[a,d]=D(!1),[u,l]=D(null),p=Y(null),s=Y(null),b=Y(!1),h=Y(i.size),m=t.maxSelectableCount;function x(f){let S=N(f),k=new Set(i);if(k.has(S))k.delete(S);else{if(!f.isAvailable)return;let _=t.selectableGifts.filter(R=>R.rewardId===f.rewardId&&k.has(N(R))).length;if(k.size>=m||_>=f.rewardMaxQuantity)return;k.add(S)}l(null),o(k)}async function g(){if(!b.current){b.current=!0,d(!0),l(null);try{let f=t.selectableGifts.filter(S=>i.has(N(S)));await n(f),T("promo_engine:gift_selected",{offer_id:t.offerId,variant_ids:f.map(S=>S.variantId),session_id:e}),r()}catch(f){l(f instanceof Error?f.message:"We couldn't update your gifts. Please try again.")}finally{b.current=!1,d(!1)}}}function y(f){!a&&f.target===f.currentTarget&&r()}return pe(()=>{let f=document.activeElement instanceof HTMLElement?document.activeElement:null;return p.current&&!p.current.open&&p.current.showModal(),s.current?.focus(),()=>{p.current?.open&&p.current.close(),f?.focus()}},[r]),c("dialog",{ref:p,class:"pe-slider-overlay","aria-labelledby":"pe-slider-title","aria-describedby":t.subtitle?"pe-slider-subtitle":void 0,onClick:y,onCancel:f=>{f.preventDefault(),a||r()},"aria-busy":a,children:c("div",{class:"pe-slider-modal",children:[c("div",{class:"pe-slider-header",children:[c("div",{children:[c("h2",{class:"pe-slider-title",id:"pe-slider-title",children:t.title}),t.subtitle&&c("p",{class:"pe-slider-subtitle",id:"pe-slider-subtitle",children:t.subtitle})]}),c("button",{ref:s,type:"button",class:"pe-slider-close",onClick:r,disabled:a,"aria-label":"Close gift selection",children:"\u2715"})]}),c("div",{class:"pe-slider-body",children:c("div",{class:"pe-gift-grid",children:t.selectableGifts.map(f=>{let S=N(f),k=i.has(S),_=!f.isAvailable;return c("button",{type:"button",class:`pe-gift-card${k?" pe-selected":""}${_?" pe-unavailable":""}`,onClick:()=>x(f),"aria-pressed":k,disabled:_&&!k,children:[k&&c("span",{class:"pe-gift-check","aria-hidden":"true",children:"\u2713"}),f.imageUrl?c("img",{class:"pe-gift-img",src:f.imageUrl,alt:f.title,loading:"lazy",width:160,height:160}):c("div",{class:"pe-gift-img-placeholder","aria-hidden":"true"}),c("p",{class:"pe-gift-name",children:f.title}),f.variantTitle&&c("p",{class:"pe-gift-variant",children:f.variantTitle}),c("p",{class:"pe-gift-price",children:f.discountedPriceCents===0?c("span",{class:"pe-gift-free",children:"Free"}):c(M,{children:[c("s",{children:mt(f.originalPriceCents,t.currencyCode)})," ",c("span",{class:"pe-gift-free",children:mt(f.discountedPriceCents,t.currencyCode)})]})}),_&&c("p",{class:"pe-gift-unavailable",children:"Out of stock"})]},S)})})}),u&&c("p",{class:"pe-slider-error",role:"alert","aria-live":"assertive",children:u}),c("div",{class:"pe-slider-footer",children:[c("p",{class:"pe-selected-count","aria-live":"polite",children:[i.size," / ",m," selected"]}),c("button",{class:"pe-btn-confirm",type:"button",onClick:g,disabled:i.size===0&&h.current===0||a,"aria-label":a?"Updating gifts":void 0,children:a?c(M,{children:[c("span",{class:"pe-spinner",style:{display:"inline-block"},"aria-hidden":"true"}),c("span",{class:"pe-sr-only",children:"Updating gifts"})]}):i.size===0?"Remove Gifts from Cart":`Add ${i.size>0?i.size:""} Gift${i.size!==1?"s":""} to Cart`})]})]})})}var B=null;function Le(t,e){Qt(),B||(B=document.createElement("div"),B.id="pe-gift-slider-root",document.body.appendChild(B)),H(O(Vt,{payload:t,sessionId:e,onClose:()=>{B&&(H(O(M,null),B),I(v.GiftSliderClosed),T("promo_engine:gift_slider_closed",{offer_id:t.offerId,session_id:e}))},onConfirm:async i=>{let o=await window.PromoEngine?.validateGiftOffer(t.offerId);if(!o)throw new Error("This gift offer is no longer available. Your cart was not changed.");let a=new Map(o.selectableGifts.map(m=>[N(m),m])),d=i.map(m=>a.get(N(m)));if(d.some(m=>!m?.isAvailable))throw new Error("One of the selected gifts is no longer available. Please choose again.");let u=new Map;for(let m of d){if(!m)continue;let x=(u.get(m.rewardId)??0)+1;if(x>m.rewardMaxQuantity)throw new Error("Too many gifts were selected for this reward.");u.set(m.rewardId,x)}if(d.length>o.maxSelectableCount)throw new Error("Too many gifts were selected for this offer.");let p=(await L.getCart()).items.filter(m=>m.properties?._promo_engine_offer_id===t.offerId),s=new Set(d.flatMap(m=>m?[N(m)]:[])),b=p.filter(m=>{let x=m.properties??{},g=`${x._promo_engine_reward_id??""}:gid://shopify/ProductVariant/${m.variant_id}`,y=x._promo_engine_offer_version===String(o.selectableGifts[0]?.offerVersion??"");return!s.has(g)||!y}),h=d.flatMap(m=>{if(!m)return[];let x=m.variantId.split("/").pop()??m.variantId;return p.some(y=>String(y.variant_id)===x&&y.properties?._promo_engine_reward_id===m.rewardId&&y.properties?._promo_engine_offer_version===String(m.offerVersion))?[]:[{variantId:m.variantId,quantity:1,properties:{_promo_engine_line_type:"gift",_promo_engine_offer_id:t.offerId,_promo_engine_reward_id:m.rewardId,_promo_engine_offer_version:String(m.offerVersion)}}]});h.length>0&&await L.addLines(h),b.length>0&&await L.removeLines(b.map(m=>({key:m.key}))),I(v.CartChanged)}}),B),T("promo_engine:gift_slider_opened",{offer_id:t.offerId,session_id:e})}function fe(t){let e=new Map,r=new Set,n=null;E(v.EvaluationCompleted,i=>{e.clear(),n=null,i.giftSlider&&Array.isArray(i.giftSlider.selectableGifts)&&(n=i.giftSlider,e.set(i.giftSlider.offerId,i.giftSlider));let o=i.giftSlider?`${i.giftSlider.offerId}:${i.cartHash}:${i.giftSlider.selectableGifts.map(a=>a.offerVersion).join(",")}`:null;i.giftSlider&&Array.isArray(i.giftSlider.selectableGifts)&&i.giftSlider.alreadySelectedCount===0&&i.giftSlider.selectableGifts.some(a=>a.isAvailable)&&o&&!r.has(o)&&(r.add(o),Le(i.giftSlider,t))}),E(v.GiftSliderRequested,i=>{(async()=>{let o="selectableGifts"in i?i:null,a=o??(i.offerId?e.get(i.offerId):n)??n;if(!a)return;if(o||!window.PromoEngine?.validateGiftOffer){Le(a,t);return}let d=await window.PromoEngine.validateGiftOffer(a.offerId);d&&(n=d,e.set(d.offerId,d),Le(d,t))})()}),document.addEventListener("click",i=>{let o=i.target instanceof Element?i.target.closest("[data-promo-gift-slider-trigger]"):null;o&&I(v.GiftSliderRequested,{offerId:o.dataset.offerId||void 0})})}var Wt=`
.pe-fbt { font-family: inherit; margin: 24px 0; }
.pe-fbt-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
.pe-fbt-products {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
}
.pe-fbt-product {
  display: flex; align-items: center; gap: 8px;
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 10px;
  cursor: pointer; transition: border-color .15s; min-width: 140px;
}
.pe-fbt-product.pe-selected { border-color: #111; background: #f9f9f9; }
.pe-fbt-product:hover { border-color: #9ca3af; }
.pe-fbt-check { width: 18px; height: 18px; flex-shrink: 0; }
.pe-fbt-img { width: 52px; height: 52px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.pe-fbt-img-ph { width: 52px; height: 52px; background: #f3f4f6; border-radius: 4px; flex-shrink: 0; }
.pe-fbt-info { min-width: 0; }
.pe-fbt-name { font-size: 12px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
.pe-fbt-price { font-size: 12px; color: #6b7280; }
.pe-fbt-price-disc { color: #059669; font-weight: 700; }
.pe-fbt-plus { font-size: 20px; color: #9ca3af; flex-shrink: 0; }
.pe-fbt-summary {
  margin-top: 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
}
.pe-fbt-total { font-size: 15px; }
.pe-fbt-total strong { font-size: 18px; }
.pe-fbt-btn {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; font-size: 14px; font-weight: 700; cursor: pointer;
  transition: background .15s;
}
.pe-fbt-btn:hover { background: #333; }
.pe-fbt-btn:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-fbt-added { color: #059669; font-weight: 600; font-size: 14px; }
`;function J(t,e){return new Intl.NumberFormat(navigator.language,{style:"currency",currency:e}).format(t/100)}function Kt({config:t,currency:e,sessionId:r}){let[n,i]=D(new Set([t.mainProduct.variantId,...t.relatedProducts.slice(0,2).map(g=>g.variantId)])),[o,a]=D(!1),[d,u]=D(!1),l=[t.mainProduct,...t.relatedProducts.slice(0,t.maxProducts-1)],p=l.filter(g=>n.has(g.variantId)),s=p.reduce((g,y)=>g+y.discountedPriceCents,0),h=p.reduce((g,y)=>g+y.priceCents,0)-s;function m(g){if(g===t.mainProduct.variantId)return;let y=new Set(n);y.has(g)?y.delete(g):y.add(g),i(y)}async function x(){if(!(o||p.length===0)){a(!0);try{await L.addLines(p.map(g=>({variantId:g.variantId,quantity:1,properties:{_promo_engine_line_type:"upsell",_promo_engine_offer_id:t.offerId}}))),u(!0),I(v.CartChanged),T("promo_engine:bundle_added_to_cart",{offer_id:t.offerId,widget_type:"fbt",variant_ids:[...n],session_id:r})}finally{a(!1)}}}return pe(()=>{T("promo_engine:widget_viewed",{offer_id:t.offerId,widget_type:"fbt",session_id:r})},[]),d?c("div",{class:"pe-fbt",children:c("p",{class:"pe-fbt-added",children:["\u2713 Added ",p.length," item(s) to cart!"]})}):c("div",{class:"pe-fbt",children:[c("h3",{class:"pe-fbt-title",children:t.title||"Frequently Bought Together"}),c("div",{class:"pe-fbt-products",children:l.map((g,y)=>{let f=n.has(g.variantId),S=g.variantId===t.mainProduct.variantId;return c(M,{children:[y>0&&c("span",{class:"pe-fbt-plus","aria-hidden":"true",children:"+"}),c("div",{class:`pe-fbt-product${f?" pe-selected":""}`,onClick:()=>m(g.variantId),role:"checkbox","aria-checked":f,tabIndex:S?-1:0,onKeyDown:k=>{(k.key===" "||k.key==="Enter")&&(k.preventDefault(),m(g.variantId))},children:[c("input",{type:"checkbox",class:"pe-fbt-check",checked:f,disabled:S,"aria-hidden":"true",tabIndex:-1,readOnly:!0}),g.imageUrl?c("img",{class:"pe-fbt-img",src:g.imageUrl,alt:g.title,loading:"lazy"}):c("div",{class:"pe-fbt-img-ph","aria-hidden":"true"}),c("div",{class:"pe-fbt-info",children:[c("p",{class:"pe-fbt-name",children:g.title}),g.variantTitle&&c("p",{class:"pe-fbt-price",children:g.variantTitle}),c("p",{class:"pe-fbt-price",children:g.discountedPriceCents<g.priceCents?c("span",{class:"pe-fbt-price-disc",children:J(g.discountedPriceCents,e)}):J(g.priceCents,e)})]})]},g.variantId)]})})}),c("div",{class:"pe-fbt-summary",children:[c("p",{class:"pe-fbt-total",children:["Total: ",c("strong",{children:J(s,e)}),h>0&&c(M,{children:[" ",c("span",{class:"pe-fbt-price-disc",children:["(save ",J(h,e),")"]})]})]}),c("button",{class:"pe-fbt-btn",onClick:x,disabled:o||p.length===0,"aria-label":`Add ${p.length} item(s) to cart for ${J(s,e)}`,children:o?"Adding\u2026":t.buttonText||`Add ${p.length} to Cart`})]})]})}function me(t,e,r,n){if(!document.getElementById("pe-fbt-styles")){let i=document.createElement("style");i.id="pe-fbt-styles",i.textContent=Wt,document.head.appendChild(i)}H(O(Kt,{config:e,currency:r,sessionId:n}),t)}function gt(t,e){if(!t.marketId)return null;let r=Number(e?.currency?.rate);return{id:t.marketId,handle:t.marketHandle??"",currencyCode:e?.currency?.active??t.currency,countryCode:t.countryCode??e?.country??null,primaryLocale:e?.locale??t.locale,exchangeRate:Number.isFinite(r)&&r>0?r:null}}var Yt=300,Jt="/apps/promo-engine/evaluate",ht="promo_engine_session_id";function _t(){return typeof crypto.randomUUID=="function"?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,t=>{let e=Math.random()*16|0;return(t==="x"?e:e&3|8).toString(16)})}function yt(){try{let t=sessionStorage.getItem(ht);return t||(t=_t(),sessionStorage.setItem(ht,t)),t}catch{return _t()}}var De=class{config;sessionId;evaluationAbort=new Q;debouncedEvaluate;lastCartHash=null;savedFetch=window.fetch.bind(window);refreshGuard=!1;capturedThemeSectionIds=[];lastEvaluationResult=null;constructor(e){this.config=e,this.sessionId=yt(),this.debouncedEvaluate=ee(()=>this.triggerEvaluation(),Yt)}init(){this.log("Promo Engine initialized",this.config),this.detectTheme(),this.listenForCartChanges(),this.triggerEvaluation()}detectTheme(){let e=window.Shopify,r=e?.theme?.schema_name??e?.theme?.name??"unknown";this.log(`[PromoEngine] Theme detected: ${r}`),!!document.querySelector("cart-drawer")&&this.log("[PromoEngine] Cart component: cart-drawer web component (Dawn-style)")}listenForCartChanges(){this.patchFetch(),document.addEventListener("cart:updated",()=>this.debouncedEvaluate.call()),document.addEventListener("cart:refresh",()=>this.debouncedEvaluate.call()),document.addEventListener("theme:cart:open",()=>this.debouncedEvaluate.call()),E(v.CartChanged,()=>this.debouncedEvaluate.call())}patchFetch(){let e=/\/cart\/(add|change|update)(\.js)?(\?|$)/,r=/\/cart(\.js|\/(add|change|update)(\.js)?)?(\?|$)/;this.savedFetch=window.fetch.bind(window);let n=this.savedFetch;window.fetch=async(i,o)=>{let a=typeof i=="string"?i:i instanceof URL?i.href:i.url,u=(o?.method??"GET").toUpperCase()==="POST"&&e.test(a),l=r.test(a),p=await n(i,o);return p.ok&&l&&(p.clone().json().then(b=>{if(!this.refreshGuard&&b!==null&&typeof b=="object"&&"sections"in b){let h=b.sections??{},m=Object.keys(h).filter(x=>typeof h[x]=="string"&&h[x].length>0);m.length>0&&(this.capturedThemeSectionIds=m,this.log("Theme section IDs captured:",m.join(", ")))}}).catch(()=>{}),u&&!this.refreshGuard&&(this.log(`[PromoEngine] Cart mutation detected (${a}) \u2014 scheduling evaluation`),this.debouncedEvaluate.call())),p}}async refreshCartUI(){let e=document.querySelector("cart-drawer"),r=this.capturedThemeSectionIds.map(l=>({sectionId:l,selector:`#shopify-section-${l}`})).filter(l=>!!document.querySelector(l.selector)),n=e?.getSectionsToRender?e.getSectionsToRender().map(l=>({sectionId:l.id,selector:l.selector??`#${l.id}`})):[],i=["cart","drawer","mini"],o=[];document.querySelectorAll('[id^="shopify-section-"]').forEach(l=>{let p=l.id.replace("shopify-section-","");i.some(s=>p.toLowerCase().includes(s))&&o.push({sectionId:p,selector:`#${l.id}`})});let a=[{sectionId:"cart-drawer",selector:"#CartDrawer"},{sectionId:"cart-drawer",selector:"#shopify-section-cart-drawer"},{sectionId:"cart-icon-bubble",selector:"#cart-icon-bubble"},{sectionId:"mini-cart",selector:"#mini-cart"},{sectionId:"mini-cart",selector:'[data-section-id="mini-cart"]'},{sectionId:"cart",selector:"#shopify-section-cart"}],d=new Set,u=[...r,...n,...o,...a].filter(l=>d.has(l.selector)?!1:(d.add(l.selector),!!document.querySelector(l.selector)));if(this.log("refreshCartUI \u2014 targets:",u.length>0?u.map(l=>`${l.sectionId}\u2192${l.selector}`).join(", "):"none found"),u.length>0){let l=[...new Set(u.map(p=>p.sectionId))];try{let p=await this.savedFetch(`/cart?sections=${l.join(",")}`,{headers:{Accept:"application/json"}});if(p.ok){let s=await p.json();if(this.log("refreshCartUI \u2014 section render response keys:",Object.keys(s.sections??{}).join(", ")||"none (Shopify returned plain cart JSON \u2014 section IDs not valid for this theme)"),s.sections){let b=0;for(let{sectionId:h,selector:m}of u){let x=s.sections[h];if(!x)continue;let g=document.querySelector(m);if(!g)continue;let y=e?.getSectionInnerHTML?e.getSectionInnerHTML(x):new DOMParser().parseFromString(x,"text/html").querySelector(".shopify-section")?.innerHTML??x;g.innerHTML=y,b++}if(b>0){this.log(`[PromoEngine] Cart UI refreshed via section rendering (${b} element(s))`);return}}}}catch{}}this.log("refreshCartUI \u2014 falling back to DOM events"),document.dispatchEvent(new CustomEvent("cart:refresh",{bubbles:!0})),document.dispatchEvent(new CustomEvent("cart:updated",{bubbles:!0})),document.dispatchEvent(new CustomEvent("theme:cart:add",{bubbles:!0}))}async triggerEvaluation(e={}){e.emitResult!==!1&&I(v.EvaluationRequested);let r;try{r=await L.getCart()}catch(u){return this.log("Failed to fetch cart",u),null}let n=this.buildCartHash(r);if(!e.force&&n===this.lastCartHash)return this.log("Cart unchanged, skipping evaluation"),this.lastEvaluationResult;let i=r.items_subtotal_price??r.total_price;this.log("[PromoEngine] Evaluating cart \u2014",r.items.map(u=>`${u.title} \xD7${u.quantity}`).join(", ")||"empty",`| subtotal: $${(i/100).toFixed(2)}`);let o=this.evaluationAbort.start(),a=window.Shopify,d=gt(this.config,a);try{let u=await fetch(Jt,{method:"POST",headers:{"Content-Type":"application/json","X-Promo-Shop":this.config.shopDomain,"X-Promo-Key":this.config.publicKey,"X-Promo-Session":this.sessionId},body:JSON.stringify({cart:this.normalizeCart(r),customer:null,market:d,locale:this.config.locale,salesChannel:"online_store",requestedUrl:window.location.href,sessionId:this.sessionId}),signal:o});if(!u.ok){let s=await u.text().catch(()=>"(no body)");throw new Error(`Evaluation failed: ${u.status} \u2014 ${s}`)}let l=await u.json();this.lastCartHash=n,this.lastEvaluationResult=l;let p=Array.isArray(l.cartActions)?l.cartActions:[];return p.length>0?this.log("[PromoEngine] Cart actions to apply:",p.map(s=>`${s.action}(${s.variantId??s.lineKey??""}\xD7${s.quantity??0})`).join(", ")):this.log("[PromoEngine] Evaluation complete \u2014 no cart actions"),await this.applyCartActions(p),p.length>0&&await this.refreshCartUI(),e.emitResult!==!1&&I(v.EvaluationCompleted,l),l}catch(u){return u.name==="AbortError"?(this.log("Evaluation aborted (superseded by newer request)"),null):(this.log("Evaluation error",u),I(v.CartMutationError,{error:u.message}),null)}}async applyCartActions(e){for(let r of e)try{switch(r.action){case"add_line":{if(!r.variantId)break;this.log(`[PromoEngine] \u2192 add_line variantId=${r.variantId} qty=${r.quantity??1}`),await L.addLines([{variantId:r.variantId,quantity:r.quantity??1,properties:r.properties??{}}]),I(v.GiftAutoAdded,{variantId:r.variantId,quantity:r.quantity}),T("promo_engine:gift_auto_added",{variant_id:r.variantId,quantity:r.quantity,session_id:this.sessionId});break}case"update_line":{this.log(`[PromoEngine] \u2192 update_line key=${r.lineKey??"?"} qty=${r.quantity??1}`);let n=await ve(),o=(n.items.find(a=>a.key===r.lineKey)??(r.offerId?ye(n,r.offerId):null))?.key??(r.variantId?be(n,parseInt(r.variantId.split("/").pop()??r.variantId,10),r.properties??{}):null);if(!o)break;r.quantity===0?(await L.removeLine({key:o}),I(v.GiftRemoved,{lineKey:o}),T("promo_engine:gift_removed",{line_key:o,reason:"quantity_correction",session_id:this.sessionId})):(await L.updateLine({key:o,quantity:r.quantity??1,properties:r.properties}),I(v.GiftUpdated,{lineKey:o,quantity:r.quantity}));break}case"remove_line":{this.log(`[PromoEngine] \u2192 remove_line key=${r.lineKey??"?"} reason=${r.reason??"offer_disqualified"}`);let n=await ve(),o=(n.items.find(a=>a.key===r.lineKey)??(r.offerId?ye(n,r.offerId):null))?.key??(r.variantId?be(n,parseInt(r.variantId.split("/").pop()??r.variantId,10),r.properties??{}):null);if(!o)break;await L.removeLine({key:o}),I(v.GiftRemoved,{lineKey:o}),T("promo_engine:gift_removed",{line_key:o,reason:r.reason??"offer_disqualified",session_id:this.sessionId});break}}}catch(n){this.log("Cart action failed",{action:r,error:n}),I(v.CartMutationError,{action:r,error:n.message}),T("promo_engine:cart_mutation_error",{action_type:r.action,error:n.message,session_id:this.sessionId})}}buildCartHash(e){return[...e.items.map(n=>{let i=Object.entries(n.properties??{}).sort(([o],[a])=>o.localeCompare(a)).map(([o,a])=>`${o}=${String(a)}`).join(",");return[n.key,n.variant_id,n.quantity,n.final_price??n.price,n.final_line_price??n.line_price??n.price*n.quantity,i].join(":")}).sort(),String(e.items_subtotal_price??e.total_price),...e.discount_codes?.map(n=>n.code).sort()??[],e.currency].join("|")}normalizeCart(e){return{token:e.token,id:null,lines:e.items.map(r=>({key:r.key,variantId:`gid://shopify/ProductVariant/${r.variant_id}`,productId:`gid://shopify/Product/${r.product_id}`,quantity:r.quantity,priceCents:r.final_price??r.price,lineSubtotalCents:r.final_line_price??r.line_price??r.price*r.quantity,compareAtPriceCents:null,properties:r.properties??{},requiresSellingPlan:r.requires_selling_plan??!1,sellingPlanId:r.selling_plan_allocation?"has-plan":null,productHandle:r.handle,productTitle:r.title,variantTitle:r.variant_title,vendor:r.vendor,productType:r.product_type,tags:r.tags?r.tags.split(", "):[],collections:[],availableForSale:r.available??!0,inventoryPolicy:r.inventory_policy?.toUpperCase()==="CONTINUE"?"CONTINUE":"DENY",inventoryQuantity:r.inventory_quantity??0})),attributes:e.attributes??{},subtotalCents:e.items_subtotal_price??e.total_price,discountCodes:e.discount_codes?.map(r=>r.code)??[],currencyCode:e.currency,totalQuantity:e.item_count}}log(e,...r){this.config.debug&&console.info(`[PromoEngine] ${e}`,...r)}api={refreshCart:()=>this.debouncedEvaluate.flush(),evaluate:()=>this.triggerEvaluation(),validateGiftOffer:async e=>{let r=await this.triggerEvaluation({force:!0,emitResult:!1});return r?.giftSlider?.offerId===e?r.giftSlider:null},prepareCheckout:async()=>{this.debouncedEvaluate.cancel(),I(v.CheckoutPrepare),await this.triggerEvaluation()},on:(e,r)=>E(e,r)}};function bt(){let t=window.__promoEngineConfig;if(!t){console.warn("[PromoEngine] No config found. Ensure the app embed is enabled in your theme.");return}let e=new De(t);window.PromoEngine=e.api,window.initFbtWidget=me,fe(yt()),e.init()}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",bt):bt();function vt(t={}){let{quantitySelectors:e=[".cart-count",".cart-item-count","[data-cart-count]"],customCartUpdateEvents:r=[],sectionRenderingEnabled:n=!1}=t,i=["cart:updated","cart:refresh","cart:change","cart-drawer:open","cartDrawer:open","drawer:open","theme:cart:open","turbo:cart-update","rebuy:cart-change","slide-cart:open",...r];for(let l of i)document.addEventListener(l,()=>{I(v.CartChanged)});let o=[];function a(){for(let l of e){let p=document.querySelectorAll(l);for(let s of p)o.includes(s)||(u.observe(s,{childList:!0,subtree:!0,characterData:!0}),o.push(s))}}let d=null,u=new MutationObserver(()=>{d&&clearTimeout(d),d=setTimeout(()=>I(v.CartChanged),300)});a(),new MutationObserver(()=>a()).observe(document.body,{childList:!0,subtree:!1}),n&&E(v.GiftAutoAdded,async()=>{let l=Xt();l.length>0&&await Zt(l)}),i.filter(l=>l.includes("open")).forEach(l=>{document.addEventListener(l,()=>{setTimeout(()=>{I(v.ProgressRerender),I(v.CartMessageRender)},100)})})}function Xt(){let t=document.querySelectorAll("[data-section-id]"),e=[];for(let r of t){let n=r.getAttribute("data-section-id");n&&(n.includes("cart")||n.includes("gift"))&&e.push(n)}return e}async function Zt(t){let e=t.map(r=>`sections[]=${encodeURIComponent(r)}`).join("&");try{let r=await fetch(`/cart?${e}`,{headers:{Accept:"application/json"}});if(!r.ok)return;let n=await r.json();for(let[i,o]of Object.entries(n.sections??{})){let a=document.querySelector(`[data-section-id="${i}"]`);a&&o&&(a.outerHTML=o)}}catch{}}var ge=class{endpoint;token;cartId=null;CART_ID_KEY="promo_engine_cart_id";constructor(e,r){this.endpoint=`https://${e}/api/2026-01/graphql.json`,this.token=r}async gql(e,r){let n=await fetch(this.endpoint,{method:"POST",headers:{"Content-Type":"application/json","X-Shopify-Storefront-Access-Token":this.token},body:JSON.stringify({query:e,variables:r})});if(!n.ok)throw new Error(`Storefront API error: ${n.status}`);let i=await n.json();if(i.errors?.length)throw new Error(i.errors[0].message);return i.data}getStoredCartId(){try{return localStorage.getItem(this.CART_ID_KEY)}catch{return null}}storeCartId(e){try{localStorage.setItem(this.CART_ID_KEY,e)}catch{}}async getOrCreateCart(){let e=this.getStoredCartId();if(e)try{let r=await this.fetchCart(e);if(r)return this.cartId=e,r}catch{}return this.createCart()}async fetchCart(e){return(await this.gql(`query GetCart($cartId: ID!) {
        cart(id: $cartId) {
          id checkoutUrl
          lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
            cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
          }}
          cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
          discountCodes { code applicable }
          buyerIdentity { countryCode customer { id } }
        }
      }`,{cartId:e})).cart}async createCart(){let r=(await this.gql(`mutation CartCreate {
        cartCreate {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`)).cartCreate.cart;return this.cartId=r.id,this.storeCartId(r.id),r}async addLines(e){let r=this.cartId??(await this.getOrCreateCart()).id;return(await this.gql(`mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,{cartId:r,lines:e.map(i=>({merchandiseId:i.merchandiseId,quantity:i.quantity,attributes:Object.entries(i.attributes??{}).map(([o,a])=>({key:o,value:a}))}))})).cartLinesAdd.cart}async updateLines(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
        cartLinesUpdate(cartId: $cartId, lines: $lines) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,{cartId:this.cartId,lines:e.map(n=>({id:n.id,quantity:n.quantity,attributes:Object.entries(n.attributes).map(([i,o])=>({key:i,value:o}))}))})).cartLinesUpdate.cart}async removeLines(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
        cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,{cartId:this.cartId,lineIds:e})).cartLinesRemove.cart}async applyDiscountCodes(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]!) {
        cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
          cart { id discountCodes { code applicable } }
        }
      }`,{cartId:this.cartId,discountCodes:e})).cartDiscountCodesUpdate.cart}async updateBuyerIdentity(e,r){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
        cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
          cart { id buyerIdentity { countryCode customer { id } } }
        }
      }`,{cartId:this.cartId,buyerIdentity:{countryCode:e,...r?{customerAccessToken:r}:{}}})).cartBuyerIdentityUpdate.cart}};var er={position:"bottom_right",style:"icon_title",primaryColor:"#111",iconSizeRem:3.5},tr=`
.pe-today-wrap {
  position: fixed; bottom: 24px; z-index: 9998;
  display: flex; flex-direction: column; align-items: flex-end; gap: 12px;
}
.pe-today-wrap.pe-left { left: 24px; align-items: flex-start; }
.pe-today-wrap.pe-right { right: 24px; }
.pe-today-trigger {
  display: flex; align-items: center; gap: 8px;
  background: var(--pe-primary, #111); color: #fff;
  border: none; border-radius: 999px; padding: 10px 16px 10px 12px;
  cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25);
  font-size: 14px; font-weight: 600; font-family: inherit;
  transition: transform .15s, box-shadow .15s; position: relative;
}
.pe-today-trigger:hover { transform: scale(1.04); box-shadow: 0 6px 20px rgba(0,0,0,.3); }
.pe-today-icon { font-size: 20px; }
.pe-today-dot {
  position: absolute; top: -2px; right: -2px; width: 10px; height: 10px;
  background: #ef4444; border-radius: 50%; border: 2px solid #fff;
  animation: pe-pulse 2s infinite;
}
@keyframes pe-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.3); opacity: .8; }
}
.pe-today-panel {
  background: #fff; border-radius: 12px; width: 280px;
  box-shadow: 0 8px 32px rgba(0,0,0,.2); overflow: hidden;
  animation: pe-slide-up .2s ease;
}
@keyframes pe-slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.pe-today-panel-header {
  padding: 12px 16px; background: var(--pe-primary, #111); color: #fff;
  display: flex; justify-content: space-between; align-items: center;
}
.pe-today-panel-title { font-size: 14px; font-weight: 700; margin: 0; }
.pe-today-close { background: none; border: none; color: #fff; font-size: 16px; cursor: pointer; padding: 0; }
.pe-today-offers { padding: 8px 0; max-height: 320px; overflow-y: auto; }
.pe-today-offer-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  cursor: pointer; transition: background .12s; text-decoration: none; color: inherit;
}
.pe-today-offer-item:hover { background: #f9f9f9; }
.pe-today-offer-img { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; background: #f3f4f6; flex-shrink: 0; }
.pe-today-offer-info { flex: 1; min-width: 0; }
.pe-today-offer-title { font-size: 13px; font-weight: 600; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pe-today-offer-desc { font-size: 11px; color: #6b7280; margin: 2px 0 0; }
.pe-today-offer-btn { font-size: 11px; color: var(--pe-primary, #111); font-weight: 700; flex-shrink: 0; }
`;function rr({items:t,config:e,sessionId:r}){let[n,i]=D(!1);if(t.length===0)return null;let o=e.position==="bottom_left"?"pe-left":"pe-right";function a(d){if(T("promo_engine:widget_clicked",{offer_id:d.offerId,widget_type:"today_offer",session_id:r}),d.redirectUrl)try{let u=new URL(d.redirectUrl,window.location.href);if(u.protocol==="http:"||u.protocol==="https:"){window.location.href=u.href;return}}catch{}i(!1)}return c("div",{class:`pe-today-wrap ${o}`,style:{"--pe-primary":e.primaryColor},children:[n&&c("div",{class:"pe-today-panel",role:"dialog","aria-label":"Today's offers",children:[c("div",{class:"pe-today-panel-header",children:[c("h3",{class:"pe-today-panel-title",children:"Today's Offers"}),c("button",{class:"pe-today-close",onClick:()=>i(!1),"aria-label":"Close",children:"\u2715"})]}),c("div",{class:"pe-today-offers",children:t.map(d=>c("div",{class:"pe-today-offer-item",onClick:()=>a(d),role:"button",tabIndex:0,onKeyDown:u=>{u.key==="Enter"&&a(d)},children:[d.imageUrl?c("img",{class:"pe-today-offer-img",src:d.imageUrl,alt:d.title,loading:"lazy"}):c("div",{class:"pe-today-offer-img","aria-hidden":"true",children:"\u{1F381}"}),c("div",{class:"pe-today-offer-info",children:[c("p",{class:"pe-today-offer-title",children:d.title}),d.description&&c("p",{class:"pe-today-offer-desc",children:d.description})]}),c("span",{class:"pe-today-offer-btn",children:d.buttonText||"View \u2192"})]},d.offerId))})]}),c("button",{class:"pe-today-trigger",onClick:()=>{i(d=>!d),n||T("promo_engine:widget_viewed",{widget_type:"today_offer",offer_count:t.length,session_id:r})},"aria-expanded":n,"aria-haspopup":"dialog","aria-label":`${t.length} offer${t.length!==1?"s":""} available`,children:[c("span",{class:"pe-today-icon","aria-hidden":"true",children:"\u{1F381}"}),e.style==="icon_title"&&c("span",{children:"Today's Deals"}),c("span",{class:"pe-today-dot","aria-hidden":"true"})]})]})}var X=null;function wt(t,e){let r={...er,...t};if(!document.getElementById("pe-today-styles")){let n=document.createElement("style");n.id="pe-today-styles",n.textContent=tr,document.head.appendChild(n)}X||(X=document.createElement("div"),X.id="pe-today-offer-root",document.body.appendChild(X)),E(v.EvaluationCompleted,n=>{let i=(Array.isArray(n.qualifiedOffers)?n.qualifiedOffers:[]).map(o=>({offerId:o.offerId,title:o.type+" offer",description:"",imageUrl:null,buttonText:"View",redirectUrl:null,badgeText:null}));H(O(rr,{items:i,config:r,sessionId:e}),X)})}function xt(t,e){return new Intl.NumberFormat(navigator.language,{style:"currency",currency:e}).format(t/100)}function nr(t,e){return[...e].sort((r,n)=>n.minQuantity-r.minQuantity).find(r=>t>=r.minQuantity)??null}function ir({config:t,sessionId:e}){let[r,n]=D(0),[i,o]=D(new Map),[a,d]=D(""),u="name_asc",[l,p]=D(!1),[s,b]=D(!1),h=t.layoutMode==="one_step_per_page",m=h?[t.steps[r]].filter(Boolean):t.steps,x=$e(()=>{let _=0;for(let R of i.values())for(let q of R.values())_+=q;return _},[i]),g=nr(x,t.tiers);function y(_,R,q){o(U=>{let w=new Map(U),P=new Map(w.get(_)??[]);return q===0?P.delete(R):P.set(R,q),w.set(_,P),w})}function f(_){return[...i.get(_)?.values()??[]].reduce((R,q)=>R+q,0)}function S(_){let R=f(_.id);return R>=_.minQuantity&&(_.maxQuantity===null||R<=_.maxQuantity)}async function k(){if(!l){p(!0);try{let _=[];for(let[R,q]of i.entries())for(let[U,w]of q.entries())_.push({variantId:U,quantity:w,properties:{_promo_engine_line_type:"bundle_component",_promo_engine_offer_id:t.offerId,_promo_engine_bundle_id:t.bundleId,_promo_engine_bundle_step_id:R,_promo_engine_bundle_title:t.title}});await L.addLines(_),b(!0),I(v.CartChanged),T("promo_engine:bundle_added_to_cart",{offer_id:t.offerId,bundle_id:t.bundleId,total_qty:x,session_id:e})}finally{p(!1)}}}return s?c("div",{class:"pe-bb-success",children:[c("p",{children:"\u2713 Bundle added to cart!"}),c("button",{onClick:()=>b(!1),children:"Build Another"})]}):c("div",{class:"pe-bb",children:[c("h1",{class:"pe-bb-title",children:t.title}),t.description&&c("p",{class:"pe-bb-desc",children:t.description}),t.tiers.length>0&&c("div",{class:"pe-bb-tiers",children:t.tiers.map(_=>c("div",{class:`pe-bb-tier${g?.minQuantity===_.minQuantity?" pe-active":""}`,children:[c("span",{class:"pe-bb-tier-label",children:_.label}),c("span",{class:"pe-bb-tier-qty",children:["Buy ",_.minQuantity,"+"]}),c("span",{class:"pe-bb-tier-discount",children:_.discountType==="percentage"?`-${Math.round(_.discountValue)}%`:xt(_.discountValue,t.currency)})]},_.minQuantity))}),m.map(_=>{let R=f(_.id),q=S(_),U=_.products.filter(w=>!a||w.title.toLowerCase().includes(a.toLowerCase())).sort((w,P)=>u==="price_asc"?w.priceCents-P.priceCents:u==="price_desc"?P.priceCents-w.priceCents:w.title.localeCompare(P.title));return c("div",{class:"pe-bb-step",children:[c("div",{class:"pe-bb-step-header",children:[c("h2",{class:"pe-bb-step-title",children:[h&&`Step ${r+1} of ${t.steps.length}: `,_.title]}),_.subtitle&&c("p",{class:"pe-bb-step-subtitle",children:_.subtitle}),c("p",{class:"pe-bb-step-count",children:[R," selected",_.minQuantity>0&&` (min ${_.minQuantity})`,_.maxQuantity&&` (max ${_.maxQuantity})`,q&&" \u2713"]})]}),_.searchEnabled&&c("input",{class:"pe-bb-search",type:"text",placeholder:"Search products...",value:a,onInput:w=>d(w.target.value),"aria-label":"Search products in this step"}),c("div",{class:"pe-bb-products",children:U.map(w=>{let P=i.get(_.id)?.get(w.variantId)??0,Ge=_.maxQuantity!==null&&R>=_.maxQuantity&&P===0;return c("div",{class:`pe-bb-product${P>0?" pe-selected":""}${w.isAvailable?"":" pe-unavailable"}${Ge?" pe-at-max":""}`,children:[w.imageUrl&&c("img",{class:"pe-bb-img",src:w.imageUrl,alt:w.title,loading:"lazy"}),c("p",{class:"pe-bb-product-name",children:w.title}),w.variantTitle&&c("p",{class:"pe-bb-variant",children:w.variantTitle}),c("p",{class:"pe-bb-price",children:xt(w.priceCents,t.currency)}),w.isAvailable?c("div",{class:"pe-bb-qty-ctrl",children:[c("button",{onClick:()=>y(_.id,w.variantId,Math.max(0,P-1)),disabled:P===0,"aria-label":`Remove ${w.title}`,children:"\u2212"}),c("span",{class:"pe-bb-qty",children:P}),c("button",{onClick:()=>y(_.id,w.variantId,P+1),disabled:Ge,"aria-label":`Add ${w.title}`,children:"+"})]}):c("span",{class:"pe-bb-oos",children:"Out of stock"})]},w.variantId)})})]},_.id)}),c("div",{class:"pe-bb-footer",children:h?c("div",{class:"pe-bb-nav",children:[r>0&&c("button",{class:"pe-bb-btn-prev",onClick:()=>n(_=>_-1),children:"\u2190 Previous"}),r<t.steps.length-1?c("button",{class:"pe-bb-btn-next",onClick:()=>{T("promo_engine:bundle_step_completed",{offer_id:t.offerId,step_index:r,session_id:e}),n(_=>_+1)},disabled:!t.steps[r]||!S(t.steps[r]),children:"Next \u2192"}):c("button",{class:"pe-bb-btn-add",onClick:k,disabled:l||!t.steps.every(_=>S(_)),children:l?"Adding\u2026":`Add Bundle to Cart${g?` (${g.label})`:""}`})]}):c("div",{class:"pe-bb-summary",children:[c("p",{class:"pe-bb-total",children:[x," items selected"]}),g&&c("p",{class:"pe-bb-saving",children:["\u{1F4B0} ",g.label," applied!"]}),c("button",{class:"pe-bb-btn-add",onClick:k,disabled:l||!t.steps.every(_=>S(_)),children:l?"Adding\u2026":"Add Bundle to Cart"})]})})]})}function Ct(t,e,r){H(O(ir,{config:e,sessionId:r}),t)}var qe=class extends HTMLElement{offerId="";widgetId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.widgetId=this.getAttribute("widget-id")??"",this.attachShadow({mode:"open"}),this.renderSkeleton(),this.unsubscribe=E(v.EvaluationCompleted,e=>{let r=(Array.isArray(e.progressBars)?e.progressBars:[]).find(n=>n.offerId===this.offerId||n.widgetId===this.widgetId);r&&this.renderPayload(r)})}disconnectedCallback(){this.unsubscribe?.()}renderSkeleton(){this.shadowRoot&&(this.shadowRoot.innerHTML=`
      <style>
        :host { display: block; font-family: inherit; }
        .pe-pb-wrap { padding: 12px 0; }
        .pe-pb-msg { font-size: 14px; margin-bottom: 8px; color: inherit; }
        .pe-pb-track {
          background: #e5e7eb; border-radius: 999px; height: 6px; overflow: hidden;
        }
        .pe-pb-fill {
          background: #111; height: 100%; border-radius: 999px;
          transition: width .4s ease; width: 0%;
        }
        .pe-pb-fill.pe-goal { background: #059669; }
      </style>
      <div class="pe-pb-wrap" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
        <p class="pe-pb-msg"></p>
        <div class="pe-pb-track"><div class="pe-pb-fill"></div></div>
      </div>
    `)}renderPayload(e){if(!this.shadowRoot)return;let r=this.shadowRoot.querySelector(".pe-pb-wrap"),n=this.shadowRoot.querySelector(".pe-pb-msg"),i=this.shadowRoot.querySelector(".pe-pb-fill");if(!r||!n||!i)return;let o=Math.min(100,Math.round(e.progressPercent)),a=e.isGoalReached?e.messageAfterGoal:e.messageBeforeGoal;n.textContent=this.interpolateMessage(a,e),i.style.width=`${o}%`,i.classList.toggle("pe-goal",e.isGoalReached),r.setAttribute("aria-valuenow",String(o)),this.setAttribute("aria-label",`Progress: ${o}%`)}interpolateMessage(e,r){let n=r.targetCents-r.currentCents,i=(r.targetQuantity??0)-r.currentQuantity,o=this.getAttribute("currency")??"USD",a=d=>new Intl.NumberFormat(navigator.language,{style:"currency",currency:o}).format(d/100);return e.replace("{{remaining_amount}}",a(Math.max(0,n))).replace("{{remaining_quantity}}",String(Math.max(0,i))).replace("{{current_amount}}",a(r.currentCents)).replace("{{target_amount}}",a(r.targetCents))}};customElements.define("promo-progress-bar",qe);var Me=class extends HTMLElement{offerId="";widgetId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.widgetId=this.getAttribute("widget-id")??"",this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=E(v.EvaluationCompleted,e=>{let r=(Array.isArray(e.cartMessages)?e.cartMessages:[]).filter(n=>n.offerId===this.offerId||n.widgetId===this.widgetId).sort((n,i)=>n.priority-i.priority);this.render(r[0]??null)})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;if(!e){this.shadowRoot.innerHTML="<style>:host { display: none; }</style>";return}let n={progress:"#f59e0b",success:"#059669",info:"#3b82f6"}[e.type]??"#111",i=this.sanitize(e.message);this.shadowRoot.innerHTML=`
      <style>
        :host { display: block; }
        .pe-msg {
          padding: 10px 14px;
          border-left: 3px solid ${n};
          background: ${n}18;
          border-radius: 0 6px 6px 0;
          font-size: 13px;
          line-height: 1.5;
          color: inherit;
        }
      </style>
      <div class="pe-msg" role="status" aria-live="polite">${i}</div>
    `}sanitize(e){let r=document.createElement("div");return r.textContent=e,r.innerHTML}};customElements.define("promo-cart-message",Me);function he(t){let e=document.createElement("div");return e.textContent=String(t??""),e.innerHTML}function or(t){if(typeof t!="string"||!t)return null;try{let e=new URL(t,window.location.href);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}var ar=`
:host { display: inline-block; }
.pe-gift-icon-wrap {
  display: inline-flex; align-items: center; gap: 6px;
  background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 999px;
  padding: 4px 12px; min-height: 48px; font-size: 13px; font-weight: 600; color: #059669;
  cursor: pointer; transition: background .15s;
  font: inherit;
}
.pe-gift-icon-wrap:hover { background: #dcfce7; }
.pe-gift-icon-wrap:focus-visible, .pe-thumb-cta:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
.pe-gift-icon-wrap.pe-hidden { display: none; }
.pe-gift-emoji { font-size: 15px; }
@media (prefers-reduced-motion: reduce) { .pe-gift-icon-wrap { transition: none; } }
`,Oe=class extends HTMLElement{offerId="";variantId="";unsubscribe=null;unsubscribeProductChanged=null;countdownTimer=null;activeOfferId="";connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.variantId=this.getAttribute("variant-id")??"",this.shadowRoot||this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=E(v.EvaluationCompleted,e=>{let r=Array.isArray(e.qualifiedOffers)?this.offerId?e.qualifiedOffers.find(n=>n.offerId===this.offerId):e.qualifiedOffers[0]:null;this.render(r?{offerId:r.offerId,offerName:"Free Gift Available"}:null)}),this.unsubscribeProductChanged=E(v.ProductChanged,e=>{this.variantId=e.variantId})}disconnectedCallback(){this.unsubscribe?.(),this.unsubscribeProductChanged?.(),this.countdownTimer!==null&&window.clearTimeout(this.countdownTimer)}render(e){if(!this.shadowRoot)return;this.activeOfferId=e?.offerId??"",this.countdownTimer!==null&&(window.clearTimeout(this.countdownTimer),this.countdownTimer=null);let r=he(this.getAttribute("label")??"Free Gift"),n=parseInt(this.getAttribute("countdown-seconds")??"0",10),i=he(e?.offerName??""),o=he(this.offerId);this.shadowRoot.innerHTML=`
      <style>${ar}</style>
      <button type="button" class="pe-gift-icon-wrap${e?"":" pe-hidden"}"
           aria-label="View free gift offer"
           title="${i}">
        <span class="pe-gift-emoji" aria-hidden="true">\u{1F381}</span>
        <span>${r}</span>
        ${n>0?`<span class="pe-countdown" id="cd-${o}"></span>`:""}
      </button>
    `,e&&(this.shadowRoot.querySelector(".pe-gift-icon-wrap")?.addEventListener("click",()=>{I(v.GiftSliderRequested,{offerId:this.activeOfferId}),T("promo_engine:widget_clicked",{offer_id:this.activeOfferId,widget_type:"gift_icon"})}),n>0&&this.startCountdown(n))}startCountdown(e){if(!this.shadowRoot)return;let r=e,n=()=>{let i=this.shadowRoot?.getElementById(`cd-${this.offerId}`);if(!i)return;let o=Math.floor(r/60),a=r%60;i.textContent=` (${o}:${String(a).padStart(2,"0")})`,r--,r>=0&&(this.countdownTimer=window.setTimeout(n,1e3))};n()}};customElements.get("promo-gift-icon")||customElements.define("promo-gift-icon",Oe);var It=`
:host { display: block; }
.pe-thumb-wrap {
  border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px;
  background: #fff; max-width: 280px;
}
.pe-thumb-wrap.pe-hidden { display: none; }
.pe-thumb-offer-name { font-size: 11px; font-weight: 700; color: #059669; text-transform: uppercase; letter-spacing: .5px; margin: 0 0 8px; }
.pe-thumb-products { display: flex; gap: 6px; flex-wrap: wrap; }
.pe-thumb-product { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.pe-thumb-img { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid #e5e7eb; }
.pe-thumb-img-ph { width: 48px; height: 48px; background: #f3f4f6; border-radius: 4px; border: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: center; font-size: 20px; }
.pe-thumb-name { font-size: 10px; color: #374151; text-align: center; max-width: 56px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-thumb-count { font-size: 12px; color: #6b7280; margin-top: 6px; }
.pe-thumb-cta { margin-top: 8px; padding: 8px 0; min-height: 48px; border: 0; background: transparent; font-size: 12px; color: #111; font-weight: 600; cursor: pointer; text-decoration: underline; }
`,Ue=class extends HTMLElement{offerId="";unsubscribe=null;activeOfferId="";connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.shadowRoot||this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=E(v.EvaluationCompleted,e=>{let r=Array.isArray(e.qualifiedOffers)?this.offerId?e.qualifiedOffers.find(i=>i.offerId===this.offerId):e.qualifiedOffers[0]:null,n=e.giftSlider;this.activeOfferId=r?.offerId??"",this.render(r&&n?.offerId===r.offerId?n.selectableGifts:null)})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;if(!e||e.length===0){this.shadowRoot.innerHTML=`<style>${It}</style><div class="pe-thumb-wrap pe-hidden"></div>`;return}let n=e.slice(0,4).map(i=>{let o=or(i.imageUrl),a=he(i.title);return o?`<div class="pe-thumb-product">
               <img class="pe-thumb-img" src="${o}" alt="${a}" loading="lazy"/>
               <span class="pe-thumb-name">${a}</span>
             </div>`:`<div class="pe-thumb-product">
               <div class="pe-thumb-img-ph" aria-hidden="true">\u{1F381}</div>
               <span class="pe-thumb-name">${a}</span>
             </div>`}).join("");this.shadowRoot.innerHTML=`
      <style>${It}</style>
      <div class="pe-thumb-wrap">
        <p class="pe-thumb-offer-name">\u{1F381} Free Gift</p>
        <div class="pe-thumb-products">${n}</div>
        ${e.length>4?`<p class="pe-thumb-count">+${e.length-4} more gifts available</p>`:""}
        <button type="button" class="pe-thumb-cta">Choose your gift \u2192</button>
      </div>
    `,this.shadowRoot.querySelector(".pe-thumb-cta")?.addEventListener("click",()=>{I(v.GiftSliderRequested,{offerId:this.activeOfferId})})}};customElements.get("promo-gift-thumbnail")||customElements.define("promo-gift-thumbnail",Ue);var sr=`
:host { display: block; }
.pe-vd-wrap { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin: 16px 0; }
.pe-vd-title { padding: 10px 14px; background: #f9fafb; font-size: 13px; font-weight: 700; border-bottom: 1px solid #e5e7eb; }
.pe-vd-tier {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid #f3f4f6; cursor: pointer;
  transition: background .1s;
}
.pe-vd-tier:last-child { border-bottom: none; }
.pe-vd-tier:hover { background: #f9fafb; }
.pe-vd-tier.pe-active { background: #f0fdf4; border-left: 3px solid #059669; }
.pe-vd-qty { font-size: 14px; font-weight: 600; }
.pe-vd-label { font-size: 12px; color: #059669; font-weight: 700; background: #dcfce7; padding: 2px 8px; border-radius: 999px; }
.pe-vd-price { text-align: right; }
.pe-vd-price-original { font-size: 12px; color: #9ca3af; text-decoration: line-through; }
.pe-vd-price-discounted { font-size: 14px; font-weight: 700; color: #059669; }
`,je=class extends HTMLElement{offerId="";variantId="";currency="USD";unsubscribeVariant=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.variantId=this.getAttribute("variant-id")??"",this.currency=this.getAttribute("currency")??"USD",this.attachShadow({mode:"open"}),this.loadAndRender(),this.unsubscribeVariant=E(v.ProductChanged,e=>{this.variantId=e.variantId,this.setAttribute("variant-id",e.variantId),this.loadAndRender()})}disconnectedCallback(){this.unsubscribeVariant?.()}async loadAndRender(){if(!(!this.offerId||!this.variantId)&&this.shadowRoot)try{let e=window.Shopify?.shop??location.hostname,r=await fetch(`/apps/promo-engine/product-customizations?offer_id=${encodeURIComponent(this.offerId)}&variant_id=${encodeURIComponent(this.variantId)}`,{headers:{"X-Promo-Shop":e}});if(!r.ok){this.renderEmpty();return}let n=await r.json();n.volumeDiscount?this.renderTiers(n.volumeDiscount):this.renderEmpty()}catch{this.renderEmpty()}}renderTiers(e){if(!this.shadowRoot)return;let r=i=>new Intl.NumberFormat(navigator.language,{style:"currency",currency:e.currency}).format(i/100),n=e.tiers.map((i,o)=>`
        <div class="pe-vd-tier ${o===0?"pe-active":""}"
             data-qty="${i.minQuantity}"
             role="button"
             tabindex="0"
             aria-label="Buy ${i.minQuantity}+ for ${r(i.discountedPriceCents)} each">
          <div>
            <p class="pe-vd-qty">${i.minQuantity===1?"1 item":`${i.minQuantity}+ items`}</p>
          </div>
          <span class="pe-vd-label">${i.label||(i.discountType==="percentage"?`-${Math.round(i.discountValue)}%`:"Deal")}</span>
          <div class="pe-vd-price">
            ${i.originalPriceCents!==i.discountedPriceCents?`<p class="pe-vd-price-original">${r(i.originalPriceCents)}</p>`:""}
            <p class="pe-vd-price-discounted">${r(i.discountedPriceCents)} each</p>
          </div>
        </div>`).join("");this.shadowRoot.innerHTML=`
      <style>${sr}</style>
      <div class="pe-vd-wrap">
        <div class="pe-vd-title">Volume Discounts</div>
        ${n}
      </div>
    `,this.shadowRoot.querySelectorAll(".pe-vd-tier").forEach(i=>{i.addEventListener("click",()=>{let o=parseInt(i.dataset.qty??"1",10),a=document.querySelector('input[name="quantity"]');a&&(a.value=String(o),a.dispatchEvent(new Event("change",{bubbles:!0}))),this.shadowRoot?.querySelectorAll(".pe-vd-tier").forEach(d=>d.classList.remove("pe-active")),i.classList.add("pe-active")})})}renderEmpty(){this.shadowRoot&&(this.shadowRoot.innerHTML="<style>:host { display: none; }</style>")}};customElements.define("promo-volume-discount",je);function Z(t){let e=document.createElement("div");return e.textContent=String(t??""),e.innerHTML}function lr(t){if(typeof t!="string"||!t)return null;try{let e=new URL(t,window.location.href);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}var St=`
:host { display: block; }
.pe-tob-wrap { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
.pe-tob-header { background: #111; color: #fff; padding: 10px 14px; font-size: 13px; font-weight: 700; }
.pe-tob-items { }
.pe-tob-item {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px;
  border-bottom: 1px solid #f3f4f6; cursor: pointer; transition: background .12s;
  text-decoration: none; color: inherit;
}
.pe-tob-item:last-child { border-bottom: none; }
.pe-tob-item:hover { background: #f9fafb; }
.pe-tob-img { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; background: #f3f4f6; flex-shrink: 0; }
.pe-tob-info { flex: 1; min-width: 0; }
.pe-tob-title { font-size: 13px; font-weight: 600; margin: 0; }
.pe-tob-desc { font-size: 11px; color: #6b7280; margin: 2px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-tob-badge { font-size: 11px; color: #059669; font-weight: 700; flex-shrink: 0; }
.pe-tob-empty { display: none; }
`,He=class extends HTMLElement{filterOfferIds=[];unsubscribe=null;connectedCallback(){let e=this.getAttribute("offer-ids");this.filterOfferIds=e?e.split(",").map(r=>r.trim()):[],this.attachShadow({mode:"open"}),this.render([]),this.unsubscribe=E(v.EvaluationCompleted,r=>{let n=Array.isArray(r.qualifiedOffers)?r.qualifiedOffers:[];this.filterOfferIds.length>0&&(n=n.filter(i=>this.filterOfferIds.includes(i.offerId))),this.render(n.map(i=>({offerId:i.offerId,title:i.type,description:"",imageUrl:null,badgeText:"Active"})))})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;let r=Z(this.getAttribute("title")??"Today's Offers");if(e.length===0){this.shadowRoot.innerHTML=`<style>${St}</style><div class="pe-tob-empty"></div>`;return}let n=e.map(i=>{let o=Z(i.offerId),a=Z(i.title),d=Z(i.description),u=Z(i.badgeText),l=lr(i.imageUrl);return`
      <div class="pe-tob-item" data-offer="${o}" role="button" tabindex="0">
        ${l?`<img class="pe-tob-img" src="${l}" alt="${a}" loading="lazy">`:'<div class="pe-tob-img" aria-hidden="true">\u{1F381}</div>'}
        <div class="pe-tob-info">
          <p class="pe-tob-title">${a}</p>
          ${d?`<p class="pe-tob-desc">${d}</p>`:""}
        </div>
        <span class="pe-tob-badge">${u}</span>
      </div>
    `}).join("");this.shadowRoot.innerHTML=`
      <style>${St}</style>
      <div class="pe-tob-wrap">
        <div class="pe-tob-header">${r}</div>
        <div class="pe-tob-items">${n}</div>
      </div>
    `,this.shadowRoot.querySelectorAll(".pe-tob-item").forEach(i=>{let o=i.dataset.offer??"";i.addEventListener("click",()=>{T("promo_engine:widget_clicked",{offer_id:o,widget_type:"today_offer_block"})})})}};customElements.define("promo-today-offer-block",He);return Rt(dr);})();
