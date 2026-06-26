"use strict";var PromoEngine=(()=>{var ue=Object.defineProperty;var vt=Object.getOwnPropertyDescriptor;var xt=Object.getOwnPropertyNames;var Ct=Object.prototype.hasOwnProperty;var wt=(t,e)=>{for(var n in e)ue(t,n,{get:e[n],enumerable:!0})},It=(t,e,n,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of xt(e))!Ct.call(t,i)&&i!==n&&ue(t,i,{get:()=>e[i],enumerable:!(r=vt(e,i))||r.enumerable});return t};var kt=t=>It(ue({},"__esModule",{value:!0}),t);var nn={};wt(nn,{AbortableRequest:()=>F,AjaxCartAdapter:()=>L,PromoEvents:()=>g,StorefrontApiAdapter:()=>Z,debounce:()=>X,emit:()=>w,initBundleBuilder:()=>gt,initCartDrawerIntegration:()=>He,initFbtWidget:()=>mt,initGiftSlider:()=>ft,initTodayOfferWidget:()=>_t,on:()=>k,publishAnalytics:()=>E});var Me=Promise.resolve();function Q(t){return new Promise((e,n)=>{Me=Me.then(t).then(e,n)})}async function B(t,e){let n=await fetch(t,{...e,headers:{"Content-Type":"application/json",Accept:"application/json",...e?.headers}});if(!n.ok){let r=await n.text();throw new Error(`Cart API error ${n.status}: ${r}`)}return n.json()}var L={async getCart(){return B(`${window.Shopify?.routes?.root??"/"}cart.js`)},async addLines(t){return Q(()=>B(`${window.Shopify?.routes?.root??"/"}cart/add.js`,{method:"POST",body:JSON.stringify({items:t.map(e=>({id:parseInt(e.variantId.split("/").pop()??e.variantId,10),quantity:e.quantity,properties:e.properties}))})}))},async updateLine(t){return Q(()=>B(`${window.Shopify?.routes?.root??"/"}cart/change.js`,{method:"POST",body:JSON.stringify({id:t.key,quantity:t.quantity,...t.properties?{properties:t.properties}:{}})}))},async removeLine(t){return Q(()=>B(`${window.Shopify?.routes?.root??"/"}cart/change.js`,{method:"POST",body:JSON.stringify({id:t.key,quantity:0})}))},async applyDiscountCode(t){return Q(()=>B(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({discount:t})}))},async removeDiscountCode(){return Q(()=>B(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({discount:""})}))}};function X(t,e){let n=null,r=null;function i(...l){r=l,n!==null&&clearTimeout(n),n=setTimeout(()=>{n=null,r&&t(...r)},e)}function o(){n!==null&&(clearTimeout(n),n=null)}function a(){o(),r&&t(...r)}return{call:i,cancel:o,flush:a}}var F=class{controller=null;start(){return this.controller&&this.controller.abort("superseded"),this.controller=new AbortController,this.controller.signal}cancel(){this.controller&&(this.controller.abort("cancelled"),this.controller=null)}};var g={CartChanged:"promo-engine:cart-changed",EvaluationRequested:"promo-engine:evaluation-requested",EvaluationCompleted:"promo-engine:evaluation-completed",GiftAutoAdded:"promo-engine:gift-auto-added",GiftAdded:"promo-engine:gift-added",GiftUpdated:"promo-engine:gift-updated",GiftRemoved:"promo-engine:gift-removed",GiftSliderRequested:"promo-engine:gift-slider-requested",GiftSliderClosed:"promo-engine:gift-slider-closed",ProductChanged:"promo-engine:product-changed",CartMessageRender:"promo-engine:cart-message-render",ProgressRerender:"promo-engine:progress-rerender",TodayOfferRender:"promo-engine:today-offer-render",BundleInit:"promo-engine:bundle-init",UpsellInit:"promo-engine:upsell-init",CheckoutPrepare:"promo-engine:checkout-prepare",CartMutationError:"promo-engine:cart-mutation-error",InventoryFailure:"promo-engine:inventory-failure"};function w(t,e){window.dispatchEvent(new CustomEvent(t,{detail:e,bubbles:!0}))}function k(t,e,n){let r=i=>e(i.detail);return window.addEventListener(t,r,n),()=>window.removeEventListener(t,r)}function E(t,e){typeof window.analytics?.publish=="function"&&window.analytics.publish(t,e)}function fe(t,e,n){for(let r of t.items){if(r.variant_id!==e)continue;if(Object.entries(n).every(([o,a])=>r.properties[o]===a))return r.key}return null}function me(t,e){return t.items.find(n=>n.properties._promo_engine_line_type==="gift"&&n.properties._promo_engine_offer_id===e)??null}async function _e(){let t=await fetch(`${window.Shopify?.routes?.root??"/"}cart.js`,{headers:{Accept:"application/json"}});if(!t.ok)throw new Error(`Cart fetch failed: ${t.status}`);return t.json()}var Et=300,St="/apps/promo-engine/evaluate",Ue="promo_engine_session_id",he=class{config;sessionId;evaluationAbort=new F;debouncedEvaluate;lastCartHash=null;savedFetch=window.fetch.bind(window);refreshGuard=!1;constructor(e){this.config=e,this.sessionId=this.getOrCreateSessionId(),this.debouncedEvaluate=X(this.triggerEvaluation.bind(this),Et)}init(){this.log("Promo Engine initialized",this.config),this.listenForCartChanges(),this.triggerEvaluation()}getOrCreateSessionId(){try{let e=sessionStorage.getItem(Ue);return e||(e=crypto.randomUUID(),sessionStorage.setItem(Ue,e)),e}catch{return crypto.randomUUID()}}listenForCartChanges(){this.patchFetch(),document.addEventListener("cart:updated",()=>this.debouncedEvaluate.call()),document.addEventListener("cart:refresh",()=>this.debouncedEvaluate.call()),document.addEventListener("theme:cart:open",()=>this.debouncedEvaluate.call()),k(g.CartChanged,()=>this.debouncedEvaluate.call())}patchFetch(){let e=/\/cart\/(add|change|update)(\.js)?(\?|$)/;this.savedFetch=window.fetch.bind(window);let n=this.savedFetch;window.fetch=async(r,i)=>{let o=typeof r=="string"?r:r instanceof URL?r.href:r.url,l=(i?.method??"GET").toUpperCase()==="POST"&&e.test(o),u=await n(r,i);return l&&u.ok&&!this.refreshGuard&&(console.info(`[PromoEngine] Cart mutation detected (${o}) \u2014 scheduling evaluation`),this.debouncedEvaluate.call()),u}}async refreshCartUI(){let e=document.querySelector("cart-drawer"),n=e?.getSectionsToRender?e.getSectionsToRender().map(u=>({sectionId:u.id,selector:u.selector??`#${u.id}`})):[],r=["cart","drawer","mini"],i=[];document.querySelectorAll('[id^="shopify-section-"]').forEach(u=>{let s=u.id.replace("shopify-section-","");r.some(f=>s.toLowerCase().includes(f))&&i.push({sectionId:s,selector:`#${u.id}`})});let o=[{sectionId:"cart-drawer",selector:"#CartDrawer"},{sectionId:"cart-drawer",selector:"#shopify-section-cart-drawer"},{sectionId:"cart-icon-bubble",selector:"#cart-icon-bubble"},{sectionId:"mini-cart",selector:"#mini-cart"},{sectionId:"mini-cart",selector:'[data-section-id="mini-cart"]'},{sectionId:"cart",selector:"#shopify-section-cart"}],a=new Set,l=[...n,...i,...o].filter(u=>a.has(u.selector)?!1:(a.add(u.selector),!!document.querySelector(u.selector)));if(l.length>0){let u=[...new Set(l.map(s=>s.sectionId))];try{let s=await this.savedFetch(`/cart?sections=${u.join(",")}`,{headers:{Accept:"application/json"}});if(s.ok){let f=await s.json();if(f.sections){let d=0;for(let{sectionId:h,selector:p}of l){let v=f.sections[h];if(!v)continue;let I=document.querySelector(p);if(!I)continue;let m=e?.getSectionInnerHTML?e.getSectionInnerHTML(v):new DOMParser().parseFromString(v,"text/html").querySelector(".shopify-section")?.innerHTML??v;I.innerHTML=m,d++}if(d>0){console.info(`[PromoEngine] Cart UI refreshed (${d} element(s))`);return}}}}catch{}}if(!this.refreshGuard){this.refreshGuard=!0;try{await window.fetch("/cart/update.js",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({updates:{}})})}catch{}finally{this.refreshGuard=!1}}document.dispatchEvent(new CustomEvent("cart:refresh",{bubbles:!0})),document.dispatchEvent(new CustomEvent("cart:updated",{bubbles:!0})),document.dispatchEvent(new CustomEvent("theme:cart:add",{bubbles:!0}))}async triggerEvaluation(){w(g.EvaluationRequested);let e;try{e=await L.getCart()}catch(s){this.log("Failed to fetch cart",s);return}let n=this.buildCartHash(e);if(n===this.lastCartHash){this.log("Cart unchanged, skipping evaluation");return}console.info("[PromoEngine] Evaluating cart \u2014",e.items.map(s=>`${s.title} \xD7${s.quantity}`).join(", ")||"empty",`| subtotal: $${(e.total_price/100).toFixed(2)}`);let r=this.evaluationAbort.start(),i=window.Shopify,o=i?.currency?.active??this.config.currency,a=i?.currency?.rate,l=a?parseFloat(a):null,u=o&&o!==this.config.currency?{id:o,handle:o.toLowerCase(),currencyCode:o,countryCode:i?.country??null,primaryLocale:i?.locale??this.config.locale,exchangeRate:l&&!isNaN(l)?l:null}:null;try{let s=await fetch(St,{method:"POST",headers:{"Content-Type":"application/json","X-Promo-Shop":this.config.shopDomain,"X-Promo-Key":this.config.publicKey,"X-Promo-Session":this.sessionId},body:JSON.stringify({cart:this.normalizeCart(e),customer:null,market:u,locale:this.config.locale,salesChannel:"online_store",requestedUrl:window.location.href,sessionId:this.sessionId}),signal:r});if(!s.ok){let h=await s.text().catch(()=>"(no body)");throw new Error(`Evaluation failed: ${s.status} \u2014 ${h}`)}let f=await s.json();this.lastCartHash=n;let d=Array.isArray(f.cartActions)?f.cartActions:[];d.length>0?console.info("[PromoEngine] Cart actions to apply:",d.map(h=>`${h.action}(${h.variantId??h.lineKey??""}\xD7${h.quantity??0})`).join(", ")):console.info("[PromoEngine] Evaluation complete \u2014 no cart actions"),await this.applyCartActions(d),d.length>0&&await this.refreshCartUI(),w(g.EvaluationCompleted,f)}catch(s){if(s.name==="AbortError"){this.log("Evaluation aborted (superseded by newer request)");return}this.log("Evaluation error",s),w(g.CartMutationError,{error:s.message})}}async applyCartActions(e){for(let n of e)try{switch(n.action){case"add_line":{if(!n.variantId)break;let r=parseInt(n.variantId.split("/").pop()??n.variantId,10);console.info(`[PromoEngine] \u2192 add_line variantId=${n.variantId} qty=${n.quantity??1}`),await L.addLines([{variantId:String(r),quantity:n.quantity??1,properties:n.properties??{}}]),w(g.GiftAutoAdded,{variantId:n.variantId,quantity:n.quantity}),E("promo_engine:gift_auto_added",{variant_id:n.variantId,quantity:n.quantity,session_id:this.sessionId});break}case"update_line":{console.info(`[PromoEngine] \u2192 update_line key=${n.lineKey??"?"} qty=${n.quantity??1}`);let r=await _e(),o=(r.items.find(a=>a.key===n.lineKey)??(n.offerId?me(r,n.offerId):null))?.key??(n.variantId?fe(r,parseInt(n.variantId.split("/").pop()??n.variantId,10),n.properties??{}):null);if(!o)break;n.quantity===0?(await L.removeLine({key:o}),w(g.GiftRemoved,{lineKey:o}),E("promo_engine:gift_removed",{line_key:o,reason:"quantity_correction",session_id:this.sessionId})):(await L.updateLine({key:o,quantity:n.quantity??1,properties:n.properties}),w(g.GiftUpdated,{lineKey:o,quantity:n.quantity}));break}case"remove_line":{console.info(`[PromoEngine] \u2192 remove_line key=${n.lineKey??"?"} reason=${n.reason??"offer_disqualified"}`);let r=await _e(),o=(r.items.find(a=>a.key===n.lineKey)??(n.offerId?me(r,n.offerId):null))?.key??(n.variantId?fe(r,parseInt(n.variantId.split("/").pop()??n.variantId,10),n.properties??{}):null);if(!o)break;await L.removeLine({key:o}),w(g.GiftRemoved,{lineKey:o}),E("promo_engine:gift_removed",{line_key:o,reason:n.reason??"offer_disqualified",session_id:this.sessionId});break}}}catch(r){this.log("Cart action failed",{action:n,error:r}),w(g.CartMutationError,{action:n,error:r.message}),E("promo_engine:cart_mutation_error",{action_type:n.action,error:r.message,session_id:this.sessionId})}}buildCartHash(e){return[...e.items.map(r=>`${r.variant_id}:${r.quantity}`).sort(),e.currency].join("|")}normalizeCart(e){return{token:e.token,id:null,lines:e.items.map(n=>({key:n.key,variantId:`gid://shopify/ProductVariant/${n.variant_id}`,productId:`gid://shopify/Product/${n.product_id}`,quantity:n.quantity,priceCents:n.price,compareAtPriceCents:null,properties:n.properties,requiresSellingPlan:n.requires_selling_plan??!1,sellingPlanId:n.selling_plan_allocation?"has-plan":null,productHandle:n.handle,productTitle:n.title,variantTitle:n.variant_title,vendor:n.vendor,productType:n.product_type,tags:n.tags?n.tags.split(", "):[],collections:[],availableForSale:n.available??!0,inventoryPolicy:n.inventory_policy?.toUpperCase()==="CONTINUE"?"CONTINUE":"DENY",inventoryQuantity:n.inventory_quantity??0})),subtotalCents:e.total_price,discountCodes:e.discount_codes?.map(n=>n.code)??[],currencyCode:e.currency,totalQuantity:e.item_count}}log(e,...n){this.config.debug&&console.info(`[PromoEngine] ${e}`,...n)}api={refreshCart:()=>this.debouncedEvaluate.flush(),evaluate:()=>this.triggerEvaluation(),prepareCheckout:async()=>{this.debouncedEvaluate.cancel(),w(g.CheckoutPrepare),await this.triggerEvaluation()},on:(e,n)=>k(e,n)}};function Oe(){let t=window.__promoEngineConfig;if(!t){console.warn("[PromoEngine] No config found. Ensure the app embed is enabled in your theme.");return}let e=new he(t);window.PromoEngine=e.api,e.init()}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",Oe):Oe();function He(t={}){let{quantitySelectors:e=[".cart-count",".cart-item-count","[data-cart-count]"],customCartUpdateEvents:n=[],sectionRenderingEnabled:r=!1}=t,i=["cart:updated","cart:refresh","cart:change","cart-drawer:open","cartDrawer:open","drawer:open","theme:cart:open","turbo:cart-update","rebuy:cart-change","slide-cart:open",...n];for(let s of i)document.addEventListener(s,()=>{w(g.CartChanged)});let o=[];function a(){for(let s of e){let f=document.querySelectorAll(s);for(let d of f)o.includes(d)||(u.observe(d,{childList:!0,subtree:!0,characterData:!0}),o.push(d))}}let l=null,u=new MutationObserver(()=>{l&&clearTimeout(l),l=setTimeout(()=>w(g.CartChanged),300)});a(),new MutationObserver(()=>a()).observe(document.body,{childList:!0,subtree:!1}),r&&k(g.GiftAutoAdded,async()=>{let s=Tt();s.length>0&&await At(s)}),i.filter(s=>s.includes("open")).forEach(s=>{document.addEventListener(s,()=>{setTimeout(()=>{w(g.ProgressRerender),w(g.CartMessageRender)},100)})})}function Tt(){let t=document.querySelectorAll("[data-section-id]"),e=[];for(let n of t){let r=n.getAttribute("data-section-id");r&&(r.includes("cart")||r.includes("gift"))&&e.push(r)}return e}async function At(t){let e=t.map(n=>`sections[]=${encodeURIComponent(n)}`).join("&");try{let n=await fetch(`/cart?${e}`,{headers:{Accept:"application/json"}});if(!n.ok)return;let r=await n.json();for(let[i,o]of Object.entries(r.sections??{})){let a=document.querySelector(`[data-section-id="${i}"]`);a&&o&&(a.outerHTML=o)}}catch{}}var Z=class{endpoint;token;cartId=null;CART_ID_KEY="promo_engine_cart_id";constructor(e,n){this.endpoint=`https://${e}/api/2026-01/graphql.json`,this.token=n}async gql(e,n){let r=await fetch(this.endpoint,{method:"POST",headers:{"Content-Type":"application/json","X-Shopify-Storefront-Access-Token":this.token},body:JSON.stringify({query:e,variables:n})});if(!r.ok)throw new Error(`Storefront API error: ${r.status}`);let i=await r.json();if(i.errors?.length)throw new Error(i.errors[0].message);return i.data}getStoredCartId(){try{return localStorage.getItem(this.CART_ID_KEY)}catch{return null}}storeCartId(e){try{localStorage.setItem(this.CART_ID_KEY,e)}catch{}}async getOrCreateCart(){let e=this.getStoredCartId();if(e)try{let n=await this.fetchCart(e);if(n)return this.cartId=e,n}catch{}return this.createCart()}async fetchCart(e){return(await this.gql(`query GetCart($cartId: ID!) {
        cart(id: $cartId) {
          id checkoutUrl
          lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
            cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
          }}
          cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
          discountCodes { code applicable }
          buyerIdentity { countryCode customer { id } }
        }
      }`,{cartId:e})).cart}async createCart(){let n=(await this.gql(`mutation CartCreate {
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
      }`)).cartCreate.cart;return this.cartId=n.id,this.storeCartId(n.id),n}async addLines(e){let n=this.cartId??(await this.getOrCreateCart()).id;return(await this.gql(`mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
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
      }`,{cartId:n,lines:e.map(i=>({merchandiseId:i.merchandiseId,quantity:i.quantity,attributes:Object.entries(i.attributes??{}).map(([o,a])=>({key:o,value:a}))}))})).cartLinesAdd.cart}async updateLines(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
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
      }`,{cartId:this.cartId,lines:e.map(r=>({id:r.id,quantity:r.quantity,attributes:Object.entries(r.attributes).map(([i,o])=>({key:i,value:o}))}))})).cartLinesUpdate.cart}async removeLines(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
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
      }`,{cartId:this.cartId,discountCodes:e})).cartDiscountCodesUpdate.cart}async updateBuyerIdentity(e,n){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
        cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
          cart { id buyerIdentity { countryCode customer { id } } }
        }
      }`,{cartId:this.cartId,buyerIdentity:{countryCode:e,...n?{customerAccessToken:n}:{}}})).cartBuyerIdentityUpdate.cart}};var se,C,Fe,Pt,N,je,Ge,Qe,ge,te,W,We,xe,be,ye,Rt,ie={},oe=[],Lt=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,de=Array.isArray;function H(t,e){for(var n in e)t[n]=e[n];return t}function Ce(t){t&&t.parentNode&&t.parentNode.removeChild(t)}function U(t,e,n){var r,i,o,a={};for(o in e)o=="key"?r=e[o]:o=="ref"?i=e[o]:a[o]=e[o];if(arguments.length>2&&(a.children=arguments.length>3?se.call(arguments,2):n),typeof t=="function"&&t.defaultProps!=null)for(o in t.defaultProps)a[o]===void 0&&(a[o]=t.defaultProps[o]);return ne(t,a,r,i,null)}function ne(t,e,n,r,i){var o={type:t,props:e,key:n,ref:r,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:i??++Fe,__i:-1,__u:0};return i==null&&C.vnode!=null&&C.vnode(o),o}function M(t){return t.children}function re(t,e){this.props=t,this.context=e}function G(t,e){if(e==null)return t.__?G(t.__,t.__i+1):null;for(var n;e<t.__k.length;e++)if((n=t.__k[e])!=null&&n.__e!=null)return n.__e;return typeof t.type=="function"?G(t):null}function $t(t){if(t.__P&&t.__d){var e=t.__v,n=e.__e,r=[],i=[],o=H({},e);o.__v=e.__v+1,C.vnode&&C.vnode(o),we(t.__P,o,e,t.__n,t.__P.namespaceURI,32&e.__u?[n]:null,r,n??G(e),!!(32&e.__u),i),o.__v=e.__v,o.__.__k[o.__i]=o,Je(r,o,i),e.__e=e.__=null,o.__e!=n&&Ve(o)}}function Ve(t){if((t=t.__)!=null&&t.__c!=null)return t.__e=t.__c.base=null,t.__k.some(function(e){if(e!=null&&e.__e!=null)return t.__e=t.__c.base=e.__e}),Ve(t)}function Ne(t){(!t.__d&&(t.__d=!0)&&N.push(t)&&!ae.__r++||je!=C.debounceRendering)&&((je=C.debounceRendering)||Ge)(ae)}function ae(){try{for(var t,e=1;N.length;)N.length>e&&N.sort(Qe),t=N.shift(),e=N.length,$t(t)}finally{N.length=ae.__r=0}}function Ke(t,e,n,r,i,o,a,l,u,s,f){var d,h,p,v,I,m,b,x=r&&r.__k||oe,R=e.length;for(u=qt(n,e,x,u,R),d=0;d<R;d++)(p=n.__k[d])!=null&&(h=p.__i!=-1&&x[p.__i]||ie,p.__i=d,m=we(t,p,h,i,o,a,l,u,s,f),v=p.__e,p.ref&&h.ref!=p.ref&&(h.ref&&Ie(h.ref,null,p),f.push(p.ref,p.__c||v,p)),I==null&&v!=null&&(I=v),(b=!!(4&p.__u))||h.__k===p.__k?(u=Ye(p,u,t,b),b&&h.__e&&(h.__e=null)):typeof p.type=="function"&&m!==void 0?u=m:v&&(u=v.nextSibling),p.__u&=-7);return n.__e=I,u}function qt(t,e,n,r,i){var o,a,l,u,s,f=n.length,d=f,h=0;for(t.__k=new Array(i),o=0;o<i;o++)(a=e[o])!=null&&typeof a!="boolean"&&typeof a!="function"?(typeof a=="string"||typeof a=="number"||typeof a=="bigint"||a.constructor==String?a=t.__k[o]=ne(null,a,null,null,null):de(a)?a=t.__k[o]=ne(M,{children:a},null,null,null):a.constructor===void 0&&a.__b>0?a=t.__k[o]=ne(a.type,a.props,a.key,a.ref?a.ref:null,a.__v):t.__k[o]=a,u=o+h,a.__=t,a.__b=t.__b+1,l=null,(s=a.__i=Dt(a,n,u,d))!=-1&&(d--,(l=n[s])&&(l.__u|=2)),l==null||l.__v==null?(s==-1&&(i>f?h--:i<f&&h++),typeof a.type!="function"&&(a.__u|=4)):s!=u&&(s==u-1?h--:s==u+1?h++:(s>u?h--:h++,a.__u|=4))):t.__k[o]=null;if(d)for(o=0;o<f;o++)(l=n[o])!=null&&(2&l.__u)==0&&(l.__e==r&&(r=G(l)),Ze(l,l));return r}function Ye(t,e,n,r){var i,o;if(typeof t.type=="function"){for(i=t.__k,o=0;i&&o<i.length;o++)i[o]&&(i[o].__=t,e=Ye(i[o],e,n,r));return e}t.__e!=e&&(r&&(e&&t.type&&!e.parentNode&&(e=G(t)),n.insertBefore(t.__e,e||null)),e=t.__e);do e=e&&e.nextSibling;while(e!=null&&e.nodeType==8);return e}function Dt(t,e,n,r){var i,o,a,l=t.key,u=t.type,s=e[n],f=s!=null&&(2&s.__u)==0;if(s===null&&l==null||f&&l==s.key&&u==s.type)return n;if(r>(f?1:0)){for(i=n-1,o=n+1;i>=0||o<e.length;)if((s=e[a=i>=0?i--:o++])!=null&&(2&s.__u)==0&&l==s.key&&u==s.type)return a}return-1}function ze(t,e,n){e[0]=="-"?t.setProperty(e,n??""):t[e]=n==null?"":typeof n!="number"||Lt.test(e)?n:n+"px"}function ee(t,e,n,r,i){var o,a;e:if(e=="style")if(typeof n=="string")t.style.cssText=n;else{if(typeof r=="string"&&(t.style.cssText=r=""),r)for(e in r)n&&e in n||ze(t.style,e,"");if(n)for(e in n)r&&n[e]==r[e]||ze(t.style,e,n[e])}else if(e[0]=="o"&&e[1]=="n")o=e!=(e=e.replace(We,"$1")),a=e.toLowerCase(),e=a in t||e=="onFocusOut"||e=="onFocusIn"?a.slice(2):e.slice(2),t.l||(t.l={}),t.l[e+o]=n,n?r?n[W]=r[W]:(n[W]=xe,t.addEventListener(e,o?ye:be,o)):t.removeEventListener(e,o?ye:be,o);else{if(i=="http://www.w3.org/2000/svg")e=e.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(e!="width"&&e!="height"&&e!="href"&&e!="list"&&e!="form"&&e!="tabIndex"&&e!="download"&&e!="rowSpan"&&e!="colSpan"&&e!="role"&&e!="popover"&&e in t)try{t[e]=n??"";break e}catch{}typeof n=="function"||(n==null||n===!1&&e[4]!="-"?t.removeAttribute(e):t.setAttribute(e,e=="popover"&&n==1?"":n))}}function Be(t){return function(e){if(this.l){var n=this.l[e.type+t];if(e[te]==null)e[te]=xe++;else if(e[te]<n[W])return;return n(C.event?C.event(e):e)}}}function we(t,e,n,r,i,o,a,l,u,s){var f,d,h,p,v,I,m,b,x,R,D,_,P,$,O,y=e.type;if(e.constructor!==void 0)return null;128&n.__u&&(u=!!(32&n.__u),o=[l=e.__e=n.__e]),(f=C.__b)&&f(e);e:if(typeof y=="function")try{if(b=e.props,x=y.prototype&&y.prototype.render,R=(f=y.contextType)&&r[f.__c],D=f?R?R.props.value:f.__:r,n.__c?m=(d=e.__c=n.__c).__=d.__E:(x?e.__c=d=new y(b,D):(e.__c=d=new re(b,D),d.constructor=y,d.render=Ut),R&&R.sub(d),d.state||(d.state={}),d.__n=r,h=d.__d=!0,d.__h=[],d._sb=[]),x&&d.__s==null&&(d.__s=d.state),x&&y.getDerivedStateFromProps!=null&&(d.__s==d.state&&(d.__s=H({},d.__s)),H(d.__s,y.getDerivedStateFromProps(b,d.__s))),p=d.props,v=d.state,d.__v=e,h)x&&y.getDerivedStateFromProps==null&&d.componentWillMount!=null&&d.componentWillMount(),x&&d.componentDidMount!=null&&d.__h.push(d.componentDidMount);else{if(x&&y.getDerivedStateFromProps==null&&b!==p&&d.componentWillReceiveProps!=null&&d.componentWillReceiveProps(b,D),e.__v==n.__v||!d.__e&&d.shouldComponentUpdate!=null&&d.shouldComponentUpdate(b,d.__s,D)===!1){e.__v!=n.__v&&(d.props=b,d.state=d.__s,d.__d=!1),e.__e=n.__e,e.__k=n.__k,e.__k.some(function(S){S&&(S.__=e)}),oe.push.apply(d.__h,d._sb),d._sb=[],d.__h.length&&a.push(d);break e}d.componentWillUpdate!=null&&d.componentWillUpdate(b,d.__s,D),x&&d.componentDidUpdate!=null&&d.__h.push(function(){d.componentDidUpdate(p,v,I)})}if(d.context=D,d.props=b,d.__P=t,d.__e=!1,_=C.__r,P=0,x)d.state=d.__s,d.__d=!1,_&&_(e),f=d.render(d.props,d.state,d.context),oe.push.apply(d.__h,d._sb),d._sb=[];else do d.__d=!1,_&&_(e),f=d.render(d.props,d.state,d.context),d.state=d.__s;while(d.__d&&++P<25);d.state=d.__s,d.getChildContext!=null&&(r=H(H({},r),d.getChildContext())),x&&!h&&d.getSnapshotBeforeUpdate!=null&&(I=d.getSnapshotBeforeUpdate(p,v)),$=f!=null&&f.type===M&&f.key==null?Xe(f.props.children):f,l=Ke(t,de($)?$:[$],e,n,r,i,o,a,l,u,s),d.base=e.__e,e.__u&=-161,d.__h.length&&a.push(d),m&&(d.__E=d.__=null)}catch(S){if(e.__v=null,u||o!=null)if(S.then){for(e.__u|=u?160:128;l&&l.nodeType==8&&l.nextSibling;)l=l.nextSibling;o[o.indexOf(l)]=null,e.__e=l}else{for(O=o.length;O--;)Ce(o[O]);ve(e)}else e.__e=n.__e,e.__k=n.__k,S.then||ve(e);C.__e(S,e,n)}else o==null&&e.__v==n.__v?(e.__k=n.__k,e.__e=n.__e):l=e.__e=Mt(n.__e,e,n,r,i,o,a,u,s);return(f=C.diffed)&&f(e),128&e.__u?void 0:l}function ve(t){t&&(t.__c&&(t.__c.__e=!0),t.__k&&t.__k.some(ve))}function Je(t,e,n){for(var r=0;r<n.length;r++)Ie(n[r],n[++r],n[++r]);C.__c&&C.__c(e,t),t.some(function(i){try{t=i.__h,i.__h=[],t.some(function(o){o.call(i)})}catch(o){C.__e(o,i.__v)}})}function Xe(t){return typeof t!="object"||t==null||t.__b>0?t:de(t)?t.map(Xe):t.constructor!==void 0?null:H({},t)}function Mt(t,e,n,r,i,o,a,l,u){var s,f,d,h,p,v,I,m=n.props||ie,b=e.props,x=e.type;if(x=="svg"?i="http://www.w3.org/2000/svg":x=="math"?i="http://www.w3.org/1998/Math/MathML":i||(i="http://www.w3.org/1999/xhtml"),o!=null){for(s=0;s<o.length;s++)if((p=o[s])&&"setAttribute"in p==!!x&&(x?p.localName==x:p.nodeType==3)){t=p,o[s]=null;break}}if(t==null){if(x==null)return document.createTextNode(b);t=document.createElementNS(i,x,b.is&&b),l&&(C.__m&&C.__m(e,o),l=!1),o=null}if(x==null)m===b||l&&t.data==b||(t.data=b);else{if(o=x=="textarea"&&b.defaultValue!=null?null:o&&se.call(t.childNodes),!l&&o!=null)for(m={},s=0;s<t.attributes.length;s++)m[(p=t.attributes[s]).name]=p.value;for(s in m)p=m[s],s=="dangerouslySetInnerHTML"?d=p:s=="children"||s in b||s=="value"&&"defaultValue"in b||s=="checked"&&"defaultChecked"in b||ee(t,s,null,p,i);for(s in b)p=b[s],s=="children"?h=p:s=="dangerouslySetInnerHTML"?f=p:s=="value"?v=p:s=="checked"?I=p:l&&typeof p!="function"||m[s]===p||ee(t,s,p,m[s],i);if(f)l||d&&(f.__html==d.__html||f.__html==t.innerHTML)||(t.innerHTML=f.__html),e.__k=[];else if(d&&(t.innerHTML=""),Ke(e.type=="template"?t.content:t,de(h)?h:[h],e,n,r,x=="foreignObject"?"http://www.w3.org/1999/xhtml":i,o,a,o?o[0]:n.__k&&G(n,0),l,u),o!=null)for(s=o.length;s--;)Ce(o[s]);l&&x!="textarea"||(s="value",x=="progress"&&v==null?t.removeAttribute("value"):v!=null&&(v!==t[s]||x=="progress"&&!v||x=="option"&&v!=m[s])&&ee(t,s,v,m[s],i),s="checked",I!=null&&I!=t[s]&&ee(t,s,I,m[s],i))}return t}function Ie(t,e,n){try{if(typeof t=="function"){var r=typeof t.__u=="function";r&&t.__u(),r&&e==null||(t.__u=t(e))}else t.current=e}catch(i){C.__e(i,n)}}function Ze(t,e,n){var r,i;if(C.unmount&&C.unmount(t),(r=t.ref)&&(r.current&&r.current!=t.__e||Ie(r,null,e)),(r=t.__c)!=null){if(r.componentWillUnmount)try{r.componentWillUnmount()}catch(o){C.__e(o,e)}r.base=r.__P=null}if(r=t.__k)for(i=0;i<r.length;i++)r[i]&&Ze(r[i],e,n||typeof t.type!="function");n||Ce(t.__e),t.__c=t.__=t.__e=void 0}function Ut(t,e,n){return this.constructor(t,n)}function j(t,e,n){var r,i,o,a;e==document&&(e=document.documentElement),C.__&&C.__(t,e),i=(r=typeof n=="function")?null:n&&n.__k||e.__k,o=[],a=[],we(e,t=(!r&&n||e).__k=U(M,null,[t]),i||ie,ie,e.namespaceURI,!r&&n?[n]:i?null:e.firstChild?se.call(e.childNodes):null,o,!r&&n?n:i?i.__e:e.firstChild,r,a),Je(o,t,a)}se=oe.slice,C={__e:function(t,e,n,r){for(var i,o,a;e=e.__;)if((i=e.__c)&&!i.__)try{if((o=i.constructor)&&o.getDerivedStateFromError!=null&&(i.setState(o.getDerivedStateFromError(t)),a=i.__d),i.componentDidCatch!=null&&(i.componentDidCatch(t,r||{}),a=i.__d),a)return i.__E=i}catch(l){t=l}throw t}},Fe=0,Pt=function(t){return t!=null&&t.constructor===void 0},re.prototype.setState=function(t,e){var n;n=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=H({},this.state),typeof t=="function"&&(t=t(H({},n),this.props)),t&&H(n,t),t!=null&&this.__v&&(e&&this._sb.push(e),Ne(this))},re.prototype.forceUpdate=function(t){this.__v&&(this.__e=!0,t&&this.__h.push(t),Ne(this))},re.prototype.render=M,N=[],Ge=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,Qe=function(t,e){return t.__v.__b-e.__v.__b},ae.__r=0,ge=Math.random().toString(8),te="__d"+ge,W="__a"+ge,We=/(PointerCapture)$|Capture$/i,xe=0,be=Be(!1),ye=Be(!0),Rt=0;var V,T,ke,et,Ee=0,dt=[],A=C,tt=A.__b,nt=A.__r,rt=A.diffed,it=A.__c,ot=A.unmount,at=A.__;function Te(t,e){A.__h&&A.__h(T,t,Ee||e),Ee=0;var n=T.__H||(T.__H={__:[],__h:[]});return t>=n.__.length&&n.__.push({}),n.__[t]}function q(t){return Ee=1,Ot(pt,t)}function Ot(t,e,n){var r=Te(V++,2);if(r.t=t,!r.__c&&(r.__=[n?n(e):pt(void 0,e),function(l){var u=r.__N?r.__N[0]:r.__[0],s=r.t(u,l);u!==s&&(r.__N=[s,r.__[1]],r.__c.setState({}))}],r.__c=T,!T.__f)){var i=function(l,u,s){if(!r.__c.__H)return!0;var f=r.__c.__H.__.filter(function(h){return h.__c});if(f.every(function(h){return!h.__N}))return!o||o.call(this,l,u,s);var d=r.__c.props!==l;return f.some(function(h){if(h.__N){var p=h.__[0];h.__=h.__N,h.__N=void 0,p!==h.__[0]&&(d=!0)}}),o&&o.call(this,l,u,s)||d};T.__f=!0;var o=T.shouldComponentUpdate,a=T.componentWillUpdate;T.componentWillUpdate=function(l,u,s){if(this.__e){var f=o;o=void 0,i(l,u,s),o=f}a&&a.call(this,l,u,s)},T.shouldComponentUpdate=i}return r.__N||r.__}function ce(t,e){var n=Te(V++,3);!A.__s&&ct(n.__H,e)&&(n.__=t,n.u=e,T.__H.__h.push(n))}function lt(t,e){var n=Te(V++,7);return ct(n.__H,e)&&(n.__=t(),n.__H=e,n.__h=t),n.__}function Ht(){for(var t;t=dt.shift();){var e=t.__H;if(t.__P&&e)try{e.__h.some(le),e.__h.some(Se),e.__h=[]}catch(n){e.__h=[],A.__e(n,t.__v)}}}A.__b=function(t){T=null,tt&&tt(t)},A.__=function(t,e){t&&e.__k&&e.__k.__m&&(t.__m=e.__k.__m),at&&at(t,e)},A.__r=function(t){nt&&nt(t),V=0;var e=(T=t.__c).__H;e&&(ke===T?(e.__h=[],T.__h=[],e.__.some(function(n){n.__N&&(n.__=n.__N),n.u=n.__N=void 0})):(e.__h.some(le),e.__h.some(Se),e.__h=[],V=0)),ke=T},A.diffed=function(t){rt&&rt(t);var e=t.__c;e&&e.__H&&(e.__H.__h.length&&(dt.push(e)!==1&&et===A.requestAnimationFrame||((et=A.requestAnimationFrame)||jt)(Ht)),e.__H.__.some(function(n){n.u&&(n.__H=n.u),n.u=void 0})),ke=T=null},A.__c=function(t,e){e.some(function(n){try{n.__h.some(le),n.__h=n.__h.filter(function(r){return!r.__||Se(r)})}catch(r){e.some(function(i){i.__h&&(i.__h=[])}),e=[],A.__e(r,n.__v)}}),it&&it(t,e)},A.unmount=function(t){ot&&ot(t);var e,n=t.__c;n&&n.__H&&(n.__H.__.some(function(r){try{le(r)}catch(i){e=i}}),n.__H=void 0,e&&A.__e(e,n.__v))};var st=typeof requestAnimationFrame=="function";function jt(t){var e,n=function(){clearTimeout(r),st&&cancelAnimationFrame(e),setTimeout(t)},r=setTimeout(n,35);st&&(e=requestAnimationFrame(n))}function le(t){var e=T,n=t.__c;typeof n=="function"&&(t.__c=void 0,n()),T=e}function Se(t){var e=T;t.__c=t.__(),T=e}function ct(t,e){return!t||t.length!==e.length||e.some(function(n,r){return n!==t[r]})}function pt(t,e){return typeof e=="function"?e(t):e}var Nt=0;function c(t,e,n,r,i,o){e||(e={});var a,l,u=e;if("ref"in u)for(l in u={},e)l=="ref"?a=e[l]:u[l]=e[l];var s={type:t,props:u,key:n,ref:a,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:--Nt,__i:-1,__u:0,__source:i,__self:o};if(typeof t=="function"&&(a=t.defaultProps))for(l in a)u[l]===void 0&&(u[l]=a[l]);return C.vnode&&C.vnode(s),s}var zt=`
.pe-slider-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.4);
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
  color: #6b7280; padding: 0 4px; line-height: 1;
}
.pe-slider-body { overflow-y: auto; padding: 16px; flex: 1; }
.pe-gift-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@media (min-width: 480px) {
  .pe-gift-grid { grid-template-columns: repeat(3, 1fr); }
}
.pe-gift-card {
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 12px 10px;
  cursor: pointer; transition: border-color .15s, box-shadow .15s; position: relative;
}
.pe-gift-card:hover:not(.pe-unavailable) { border-color: #111; }
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
.pe-slider-footer {
  padding: 14px 20px; border-top: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.pe-selected-count { font-size: 13px; color: #6b7280; }
.pe-btn-confirm {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background .15s; flex: 1;
}
.pe-btn-confirm:hover { background: #333; }
.pe-btn-confirm:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-loading { display: flex; align-items: center; justify-content: center; padding: 40px; }
.pe-spinner {
  width: 28px; height: 28px; border: 3px solid #e5e7eb;
  border-top-color: #111; border-radius: 50%; animation: pe-spin .7s linear infinite;
}
@keyframes pe-spin { to { transform: rotate(360deg); } }
`;function Bt(){if(document.getElementById("pe-slider-styles"))return;let t=document.createElement("style");t.id="pe-slider-styles",t.textContent=zt,document.head.appendChild(t)}function Ft({payload:t,sessionId:e,onClose:n,onConfirm:r}){let[i,o]=q(new Set(t.selectableGifts.filter(p=>p.isSelected).map(p=>p.variantId))),[a,l]=q(!1),u=t.maxSelectableCount-t.alreadySelectedCount,s=i.size<u;function f(p){if(!p.isAvailable)return;let v=new Set(i);v.has(p.variantId)?v.delete(p.variantId):s&&v.add(p.variantId),o(v)}async function d(){l(!0);try{await r([...i]),E("promo_engine:gift_selected",{offer_id:t.offerId,variant_ids:[...i],session_id:e}),n()}finally{l(!1)}}function h(p){p.target.classList.contains("pe-slider-overlay")&&n()}return ce(()=>{let p=v=>{v.key==="Escape"&&n()};return window.addEventListener("keydown",p),()=>window.removeEventListener("keydown",p)},[n]),c("div",{class:"pe-slider-overlay",onClick:h,role:"dialog","aria-modal":"true",children:c("div",{class:"pe-slider-modal",children:[c("div",{class:"pe-slider-header",children:[c("div",{children:[c("h2",{class:"pe-slider-title",children:t.title}),t.subtitle&&c("p",{class:"pe-slider-subtitle",children:t.subtitle})]}),c("button",{class:"pe-slider-close",onClick:n,"aria-label":"Close gift selection",children:"\u2715"})]}),c("div",{class:"pe-slider-body",children:c("div",{class:"pe-gift-grid",children:t.selectableGifts.map(p=>{let v=i.has(p.variantId),I=!p.isAvailable;return c("div",{class:`pe-gift-card${v?" pe-selected":""}${I?" pe-unavailable":""}`,onClick:()=>f(p),role:"checkbox","aria-checked":v,"aria-disabled":I,tabIndex:I?-1:0,onKeyDown:m=>{(m.key==="Enter"||m.key===" ")&&(m.preventDefault(),f(p))},children:[v&&c("span",{class:"pe-gift-check","aria-hidden":"true",children:"\u2713"}),p.imageUrl?c("img",{class:"pe-gift-img",src:p.imageUrl,alt:p.title,loading:"lazy",width:160,height:160}):c("div",{class:"pe-gift-img-placeholder","aria-hidden":"true"}),c("p",{class:"pe-gift-name",children:p.title}),p.variantTitle&&c("p",{class:"pe-gift-variant",children:p.variantTitle}),c("p",{class:"pe-gift-price",children:p.discountedPriceCents===0?c("span",{class:"pe-gift-free",children:"Free"}):c(M,{children:[c("s",{children:["$",(p.originalPriceCents/100).toFixed(2)]})," ",c("span",{class:"pe-gift-free",children:["$",(p.discountedPriceCents/100).toFixed(2)]})]})}),I&&c("p",{style:{fontSize:"11px",color:"#ef4444",marginTop:"4px"},children:"Out of stock"})]},p.variantId)})})}),c("div",{class:"pe-slider-footer",children:[c("p",{class:"pe-selected-count",children:[i.size," / ",u," selected"]}),c("button",{class:"pe-btn-confirm",onClick:d,disabled:i.size===0||a,children:a?c("span",{class:"pe-spinner",style:{display:"inline-block"}}):`Add ${i.size>0?i.size:""} Gift${i.size!==1?"s":""} to Cart`})]})]})})}var z=null;function ut(t,e){Bt(),z||(z=document.createElement("div"),z.id="pe-gift-slider-root",document.body.appendChild(z)),j(U(Ft,{payload:t,sessionId:e,onClose:()=>{z&&(j(U(M,null),z),w(g.GiftSliderClosed),E("promo_engine:gift_slider_opened",{offer_id:t.offerId,session_id:e}))},onConfirm:async i=>{let a=(await L.getCart()).items.filter(l=>l.properties._promo_engine_offer_id===t.offerId);for(let l of a)i.includes(String(l.variant_id))||await L.removeLine({key:l.key});for(let l of i)if(!a.some(s=>String(s.variant_id)===l)){let s=t.selectableGifts.find(f=>f.variantId===l);await L.addLines([{variantId:l,quantity:1,properties:{_promo_engine_line_type:"gift",_promo_engine_offer_id:t.offerId,_promo_engine_reward_id:s?.variantId??l,_promo_engine_offer_version:"1",_promo_engine_hash:""}}])}w(g.CartChanged)}}),z),E("promo_engine:gift_slider_opened",{offer_id:t.offerId,session_id:e})}function ft(t){k(g.EvaluationCompleted,e=>{e.giftSlider&&Array.isArray(e.giftSlider.selectableGifts)&&ut(e.giftSlider,t)}),k(g.GiftSliderRequested,e=>{ut(e,t)})}var Gt=`
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
`;function K(t,e){return new Intl.NumberFormat(navigator.language,{style:"currency",currency:e}).format(t/100)}function Qt({config:t,currency:e,sessionId:n}){let[r,i]=q(new Set([t.mainProduct.variantId,...t.relatedProducts.slice(0,2).map(m=>m.variantId)])),[o,a]=q(!1),[l,u]=q(!1),s=[t.mainProduct,...t.relatedProducts.slice(0,t.maxProducts-1)],f=s.filter(m=>r.has(m.variantId)),d=f.reduce((m,b)=>m+b.discountedPriceCents,0),p=f.reduce((m,b)=>m+b.priceCents,0)-d;function v(m){if(m===t.mainProduct.variantId)return;let b=new Set(r);b.has(m)?b.delete(m):b.add(m),i(b)}async function I(){if(!(o||f.length===0)){a(!0);try{await L.addLines(f.map(m=>({variantId:m.variantId,quantity:1,properties:{_promo_engine_line_type:"upsell",_promo_engine_offer_id:t.offerId}}))),u(!0),w(g.CartChanged),E("promo_engine:bundle_added_to_cart",{offer_id:t.offerId,widget_type:"fbt",variant_ids:[...r],session_id:n})}finally{a(!1)}}}return ce(()=>{E("promo_engine:widget_viewed",{offer_id:t.offerId,widget_type:"fbt",session_id:n})},[]),l?c("div",{class:"pe-fbt",children:c("p",{class:"pe-fbt-added",children:["\u2713 Added ",f.length," item(s) to cart!"]})}):c("div",{class:"pe-fbt",children:[c("h3",{class:"pe-fbt-title",children:t.title||"Frequently Bought Together"}),c("div",{class:"pe-fbt-products",children:s.map((m,b)=>{let x=r.has(m.variantId),R=m.variantId===t.mainProduct.variantId;return c(M,{children:[b>0&&c("span",{class:"pe-fbt-plus","aria-hidden":"true",children:"+"}),c("div",{class:`pe-fbt-product${x?" pe-selected":""}`,onClick:()=>v(m.variantId),role:"checkbox","aria-checked":x,tabIndex:R?-1:0,onKeyDown:D=>{(D.key===" "||D.key==="Enter")&&(D.preventDefault(),v(m.variantId))},children:[c("input",{type:"checkbox",class:"pe-fbt-check",checked:x,disabled:R,"aria-hidden":"true",tabIndex:-1,readOnly:!0}),m.imageUrl?c("img",{class:"pe-fbt-img",src:m.imageUrl,alt:m.title,loading:"lazy"}):c("div",{class:"pe-fbt-img-ph","aria-hidden":"true"}),c("div",{class:"pe-fbt-info",children:[c("p",{class:"pe-fbt-name",children:m.title}),m.variantTitle&&c("p",{class:"pe-fbt-price",children:m.variantTitle}),c("p",{class:"pe-fbt-price",children:m.discountedPriceCents<m.priceCents?c("span",{class:"pe-fbt-price-disc",children:K(m.discountedPriceCents,e)}):K(m.priceCents,e)})]})]},m.variantId)]})})}),c("div",{class:"pe-fbt-summary",children:[c("p",{class:"pe-fbt-total",children:["Total: ",c("strong",{children:K(d,e)}),p>0&&c(M,{children:[" ",c("span",{class:"pe-fbt-price-disc",children:["(save ",K(p,e),")"]})]})]}),c("button",{class:"pe-fbt-btn",onClick:I,disabled:o||f.length===0,"aria-label":`Add ${f.length} item(s) to cart for ${K(d,e)}`,children:o?"Adding\u2026":t.buttonText||`Add ${f.length} to Cart`})]})]})}function mt(t,e,n,r){if(!document.getElementById("pe-fbt-styles")){let i=document.createElement("style");i.id="pe-fbt-styles",i.textContent=Gt,document.head.appendChild(i)}j(U(Qt,{config:e,currency:n,sessionId:r}),t)}var Wt={position:"bottom_right",style:"icon_title",primaryColor:"#111",iconSizeRem:3.5},Vt=`
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
`;function Kt({items:t,config:e,sessionId:n}){let[r,i]=q(!1);if(t.length===0)return null;let o=e.position==="bottom_left"?"pe-left":"pe-right";function a(l){if(E("promo_engine:widget_clicked",{offer_id:l.offerId,widget_type:"today_offer",session_id:n}),l.redirectUrl)try{let u=new URL(l.redirectUrl,window.location.href);if(u.protocol==="http:"||u.protocol==="https:"){window.location.href=u.href;return}}catch{}i(!1)}return c("div",{class:`pe-today-wrap ${o}`,style:{"--pe-primary":e.primaryColor},children:[r&&c("div",{class:"pe-today-panel",role:"dialog","aria-label":"Today's offers",children:[c("div",{class:"pe-today-panel-header",children:[c("h3",{class:"pe-today-panel-title",children:"Today's Offers"}),c("button",{class:"pe-today-close",onClick:()=>i(!1),"aria-label":"Close",children:"\u2715"})]}),c("div",{class:"pe-today-offers",children:t.map(l=>c("div",{class:"pe-today-offer-item",onClick:()=>a(l),role:"button",tabIndex:0,onKeyDown:u=>{u.key==="Enter"&&a(l)},children:[l.imageUrl?c("img",{class:"pe-today-offer-img",src:l.imageUrl,alt:l.title,loading:"lazy"}):c("div",{class:"pe-today-offer-img","aria-hidden":"true",children:"\u{1F381}"}),c("div",{class:"pe-today-offer-info",children:[c("p",{class:"pe-today-offer-title",children:l.title}),l.description&&c("p",{class:"pe-today-offer-desc",children:l.description})]}),c("span",{class:"pe-today-offer-btn",children:l.buttonText||"View \u2192"})]},l.offerId))})]}),c("button",{class:"pe-today-trigger",onClick:()=>{i(l=>!l),r||E("promo_engine:widget_viewed",{widget_type:"today_offer",offer_count:t.length,session_id:n})},"aria-expanded":r,"aria-haspopup":"dialog","aria-label":`${t.length} offer${t.length!==1?"s":""} available`,children:[c("span",{class:"pe-today-icon","aria-hidden":"true",children:"\u{1F381}"}),e.style==="icon_title"&&c("span",{children:"Today's Deals"}),c("span",{class:"pe-today-dot","aria-hidden":"true"})]})]})}var Y=null;function _t(t,e){let n={...Wt,...t};if(!document.getElementById("pe-today-styles")){let r=document.createElement("style");r.id="pe-today-styles",r.textContent=Vt,document.head.appendChild(r)}Y||(Y=document.createElement("div"),Y.id="pe-today-offer-root",document.body.appendChild(Y)),k(g.EvaluationCompleted,r=>{let i=(Array.isArray(r.qualifiedOffers)?r.qualifiedOffers:[]).map(o=>({offerId:o.offerId,title:o.type+" offer",description:"",imageUrl:null,buttonText:"View",redirectUrl:null,badgeText:null}));j(U(Kt,{items:i,config:n,sessionId:e}),Y)})}function ht(t,e){return new Intl.NumberFormat(navigator.language,{style:"currency",currency:e}).format(t/100)}function Yt(t,e){return[...e].sort((n,r)=>r.minQuantity-n.minQuantity).find(n=>t>=n.minQuantity)??null}function Jt({config:t,sessionId:e}){let[n,r]=q(0),[i,o]=q(new Map),[a,l]=q(""),u="name_asc",[s,f]=q(!1),[d,h]=q(!1),p=t.layoutMode==="one_step_per_page",v=p?[t.steps[n]].filter(Boolean):t.steps,I=lt(()=>{let _=0;for(let P of i.values())for(let $ of P.values())_+=$;return _},[i]),m=Yt(I,t.tiers);function b(_,P,$){o(O=>{let y=new Map(O),S=new Map(y.get(_)??[]);return $===0?S.delete(P):S.set(P,$),y.set(_,S),y})}function x(_){return[...i.get(_)?.values()??[]].reduce((P,$)=>P+$,0)}function R(_){let P=x(_.id);return P>=_.minQuantity&&(_.maxQuantity===null||P<=_.maxQuantity)}async function D(){if(!s){f(!0);try{let _=[];for(let[P,$]of i.entries())for(let[O,y]of $.entries())_.push({variantId:O,quantity:y,properties:{_promo_engine_line_type:"bundle_component",_promo_engine_offer_id:t.offerId,_promo_engine_bundle_id:t.bundleId,_promo_engine_bundle_step_id:P,_promo_engine_bundle_title:t.title,_promo_engine_hash:""}});await L.addLines(_),h(!0),w(g.CartChanged),E("promo_engine:bundle_added_to_cart",{offer_id:t.offerId,bundle_id:t.bundleId,total_qty:I,session_id:e})}finally{f(!1)}}}return d?c("div",{class:"pe-bb-success",children:[c("p",{children:"\u2713 Bundle added to cart!"}),c("button",{onClick:()=>h(!1),children:"Build Another"})]}):c("div",{class:"pe-bb",children:[c("h1",{class:"pe-bb-title",children:t.title}),t.description&&c("p",{class:"pe-bb-desc",children:t.description}),t.tiers.length>0&&c("div",{class:"pe-bb-tiers",children:t.tiers.map(_=>c("div",{class:`pe-bb-tier${m?.minQuantity===_.minQuantity?" pe-active":""}`,children:[c("span",{class:"pe-bb-tier-label",children:_.label}),c("span",{class:"pe-bb-tier-qty",children:["Buy ",_.minQuantity,"+"]}),c("span",{class:"pe-bb-tier-discount",children:_.discountType==="percentage"?`-${Math.round(_.discountValue)}%`:ht(_.discountValue,t.currency)})]},_.minQuantity))}),v.map(_=>{let P=x(_.id),$=R(_),O=_.products.filter(y=>!a||y.title.toLowerCase().includes(a.toLowerCase())).sort((y,S)=>u==="price_asc"?y.priceCents-S.priceCents:u==="price_desc"?S.priceCents-y.priceCents:y.title.localeCompare(S.title));return c("div",{class:"pe-bb-step",children:[c("div",{class:"pe-bb-step-header",children:[c("h2",{class:"pe-bb-step-title",children:[p&&`Step ${n+1} of ${t.steps.length}: `,_.title]}),_.subtitle&&c("p",{class:"pe-bb-step-subtitle",children:_.subtitle}),c("p",{class:"pe-bb-step-count",children:[P," selected",_.minQuantity>0&&` (min ${_.minQuantity})`,_.maxQuantity&&` (max ${_.maxQuantity})`,$&&" \u2713"]})]}),_.searchEnabled&&c("input",{class:"pe-bb-search",type:"text",placeholder:"Search products...",value:a,onInput:y=>l(y.target.value),"aria-label":"Search products in this step"}),c("div",{class:"pe-bb-products",children:O.map(y=>{let S=i.get(_.id)?.get(y.variantId)??0,De=_.maxQuantity!==null&&P>=_.maxQuantity&&S===0;return c("div",{class:`pe-bb-product${S>0?" pe-selected":""}${y.isAvailable?"":" pe-unavailable"}${De?" pe-at-max":""}`,children:[y.imageUrl&&c("img",{class:"pe-bb-img",src:y.imageUrl,alt:y.title,loading:"lazy"}),c("p",{class:"pe-bb-product-name",children:y.title}),y.variantTitle&&c("p",{class:"pe-bb-variant",children:y.variantTitle}),c("p",{class:"pe-bb-price",children:ht(y.priceCents,t.currency)}),y.isAvailable?c("div",{class:"pe-bb-qty-ctrl",children:[c("button",{onClick:()=>b(_.id,y.variantId,Math.max(0,S-1)),disabled:S===0,"aria-label":`Remove ${y.title}`,children:"\u2212"}),c("span",{class:"pe-bb-qty",children:S}),c("button",{onClick:()=>b(_.id,y.variantId,S+1),disabled:De,"aria-label":`Add ${y.title}`,children:"+"})]}):c("span",{class:"pe-bb-oos",children:"Out of stock"})]},y.variantId)})})]},_.id)}),c("div",{class:"pe-bb-footer",children:p?c("div",{class:"pe-bb-nav",children:[n>0&&c("button",{class:"pe-bb-btn-prev",onClick:()=>r(_=>_-1),children:"\u2190 Previous"}),n<t.steps.length-1?c("button",{class:"pe-bb-btn-next",onClick:()=>{E("promo_engine:bundle_step_completed",{offer_id:t.offerId,step_index:n,session_id:e}),r(_=>_+1)},disabled:!t.steps[n]||!R(t.steps[n]),children:"Next \u2192"}):c("button",{class:"pe-bb-btn-add",onClick:D,disabled:s||!t.steps.every(_=>R(_)),children:s?"Adding\u2026":`Add Bundle to Cart${m?` (${m.label})`:""}`})]}):c("div",{class:"pe-bb-summary",children:[c("p",{class:"pe-bb-total",children:[I," items selected"]}),m&&c("p",{class:"pe-bb-saving",children:["\u{1F4B0} ",m.label," applied!"]}),c("button",{class:"pe-bb-btn-add",onClick:D,disabled:s||!t.steps.every(_=>R(_)),children:s?"Adding\u2026":"Add Bundle to Cart"})]})})]})}function gt(t,e,n){j(U(Jt,{config:e,sessionId:n}),t)}var Ae=class extends HTMLElement{offerId="";widgetId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.widgetId=this.getAttribute("widget-id")??"",this.attachShadow({mode:"open"}),this.renderSkeleton(),this.unsubscribe=k(g.EvaluationCompleted,e=>{let n=(Array.isArray(e.progressBars)?e.progressBars:[]).find(r=>r.offerId===this.offerId||r.widgetId===this.widgetId);n&&this.renderPayload(n)})}disconnectedCallback(){this.unsubscribe?.()}renderSkeleton(){this.shadowRoot&&(this.shadowRoot.innerHTML=`
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
    `)}renderPayload(e){if(!this.shadowRoot)return;let n=this.shadowRoot.querySelector(".pe-pb-wrap"),r=this.shadowRoot.querySelector(".pe-pb-msg"),i=this.shadowRoot.querySelector(".pe-pb-fill");if(!n||!r||!i)return;let o=Math.min(100,Math.round(e.progressPercent)),a=e.isGoalReached?e.messageAfterGoal:e.messageBeforeGoal;r.textContent=this.interpolateMessage(a,e),i.style.width=`${o}%`,i.classList.toggle("pe-goal",e.isGoalReached),n.setAttribute("aria-valuenow",String(o)),this.setAttribute("aria-label",`Progress: ${o}%`)}interpolateMessage(e,n){let r=n.targetCents-n.currentCents,i=(n.targetQuantity??0)-n.currentQuantity,o=this.getAttribute("currency")??"USD",a=l=>new Intl.NumberFormat(navigator.language,{style:"currency",currency:o}).format(l/100);return e.replace("{{remaining_amount}}",a(Math.max(0,r))).replace("{{remaining_quantity}}",String(Math.max(0,i))).replace("{{current_amount}}",a(n.currentCents)).replace("{{target_amount}}",a(n.targetCents))}};customElements.define("promo-progress-bar",Ae);var Pe=class extends HTMLElement{offerId="";widgetId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.widgetId=this.getAttribute("widget-id")??"",this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=k(g.EvaluationCompleted,e=>{let n=(Array.isArray(e.cartMessages)?e.cartMessages:[]).filter(r=>r.offerId===this.offerId||r.widgetId===this.widgetId).sort((r,i)=>r.priority-i.priority);this.render(n[0]??null)})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;if(!e){this.shadowRoot.innerHTML="<style>:host { display: none; }</style>";return}let r={progress:"#f59e0b",success:"#059669",info:"#3b82f6"}[e.type]??"#111",i=this.sanitize(e.message);this.shadowRoot.innerHTML=`
      <style>
        :host { display: block; }
        .pe-msg {
          padding: 10px 14px;
          border-left: 3px solid ${r};
          background: ${r}18;
          border-radius: 0 6px 6px 0;
          font-size: 13px;
          line-height: 1.5;
          color: inherit;
        }
      </style>
      <div class="pe-msg" role="status" aria-live="polite">${i}</div>
    `}sanitize(e){let n=document.createElement("div");return n.textContent=e,n.innerHTML}};customElements.define("promo-cart-message",Pe);function pe(t){let e=document.createElement("div");return e.textContent=String(t??""),e.innerHTML}function Xt(t){if(typeof t!="string"||!t)return null;try{let e=new URL(t,window.location.href);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}var Zt=`
:host { display: inline-block; }
.pe-gift-icon-wrap {
  display: inline-flex; align-items: center; gap: 6px;
  background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 999px;
  padding: 4px 12px; font-size: 13px; font-weight: 600; color: #059669;
  cursor: pointer; transition: background .15s;
}
.pe-gift-icon-wrap:hover { background: #dcfce7; }
.pe-gift-icon-wrap.pe-hidden { display: none; }
.pe-gift-emoji { font-size: 15px; }
`,Re=class extends HTMLElement{offerId="";variantId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.variantId=this.getAttribute("variant-id")??"",this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=k(g.EvaluationCompleted,e=>{let n=Array.isArray(e.qualifiedOffers)?e.qualifiedOffers.find(r=>r.offerId===this.offerId):null;this.render(n?{offerName:"Free Gift Available"}:null)}),k(g.ProductChanged,e=>{this.variantId=e.variantId})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;let n=pe(this.getAttribute("label")??"Free Gift"),r=parseInt(this.getAttribute("countdown-seconds")??"0",10),i=pe(e?.offerName??""),o=pe(this.offerId);this.shadowRoot.innerHTML=`
      <style>${Zt}</style>
      <div class="pe-gift-icon-wrap${e?"":" pe-hidden"}"
           role="button" tabindex="0"
           aria-label="View free gift offer"
           title="${i}">
        <span class="pe-gift-emoji" aria-hidden="true">\u{1F381}</span>
        <span>${n}</span>
        ${r>0?`<span class="pe-countdown" id="cd-${o}"></span>`:""}
      </div>
    `,e&&(this.shadowRoot.querySelector(".pe-gift-icon-wrap")?.addEventListener("click",()=>{w(g.GiftSliderRequested,{offerId:this.offerId}),E("promo_engine:widget_clicked",{offer_id:this.offerId,widget_type:"gift_icon"})}),r>0&&this.startCountdown(r))}startCountdown(e){if(!this.shadowRoot)return;let n=e,r=()=>{let i=this.shadowRoot?.getElementById(`cd-${this.offerId}`);if(!i)return;let o=Math.floor(n/60),a=n%60;i.textContent=` (${o}:${String(a).padStart(2,"0")})`,n--,n>=0&&setTimeout(r,1e3)};r()}};customElements.define("promo-gift-icon",Re);var bt=`
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
.pe-thumb-cta { margin-top: 8px; font-size: 12px; color: #111; font-weight: 600; cursor: pointer; text-decoration: underline; }
`,Le=class extends HTMLElement{offerId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=k(g.EvaluationCompleted,e=>{let n=Array.isArray(e.qualifiedOffers)?e.qualifiedOffers.find(i=>i.offerId===this.offerId):null,r=e.giftSlider;this.render(n&&r?r.selectableGifts:null)})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;if(!e||e.length===0){this.shadowRoot.innerHTML=`<style>${bt}</style><div class="pe-thumb-wrap pe-hidden"></div>`;return}let r=e.slice(0,4).map(i=>{let o=Xt(i.imageUrl),a=pe(i.title);return o?`<div class="pe-thumb-product">
               <img class="pe-thumb-img" src="${o}" alt="${a}" loading="lazy"/>
               <span class="pe-thumb-name">${a}</span>
             </div>`:`<div class="pe-thumb-product">
               <div class="pe-thumb-img-ph" aria-hidden="true">\u{1F381}</div>
               <span class="pe-thumb-name">${a}</span>
             </div>`}).join("");this.shadowRoot.innerHTML=`
      <style>${bt}</style>
      <div class="pe-thumb-wrap">
        <p class="pe-thumb-offer-name">\u{1F381} Free Gift</p>
        <div class="pe-thumb-products">${r}</div>
        ${e.length>4?`<p class="pe-thumb-count">+${e.length-4} more gifts available</p>`:""}
        <p class="pe-thumb-cta" role="button" tabindex="0">Choose your gift \u2192</p>
      </div>
    `,this.shadowRoot.querySelector(".pe-thumb-cta")?.addEventListener("click",()=>{w(g.GiftSliderRequested,{offerId:this.offerId})})}};customElements.define("promo-gift-thumbnail",Le);var en=`
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
`,$e=class extends HTMLElement{offerId="";variantId="";currency="USD";unsubscribeVariant=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.variantId=this.getAttribute("variant-id")??"",this.currency=this.getAttribute("currency")??"USD",this.attachShadow({mode:"open"}),this.loadAndRender(),this.unsubscribeVariant=k(g.ProductChanged,e=>{this.variantId=e.variantId,this.setAttribute("variant-id",e.variantId),this.loadAndRender()})}disconnectedCallback(){this.unsubscribeVariant?.()}async loadAndRender(){if(!(!this.offerId||!this.variantId)&&this.shadowRoot)try{let e=window.Shopify?.shop??location.hostname,n=await fetch(`/apps/promo-engine/product-customizations?offer_id=${encodeURIComponent(this.offerId)}&variant_id=${encodeURIComponent(this.variantId)}`,{headers:{"X-Promo-Shop":e}});if(!n.ok){this.renderEmpty();return}let r=await n.json();r.volumeDiscount?this.renderTiers(r.volumeDiscount):this.renderEmpty()}catch{this.renderEmpty()}}renderTiers(e){if(!this.shadowRoot)return;let n=i=>new Intl.NumberFormat(navigator.language,{style:"currency",currency:e.currency}).format(i/100),r=e.tiers.map((i,o)=>`
        <div class="pe-vd-tier ${o===0?"pe-active":""}"
             data-qty="${i.minQuantity}"
             role="button"
             tabindex="0"
             aria-label="Buy ${i.minQuantity}+ for ${n(i.discountedPriceCents)} each">
          <div>
            <p class="pe-vd-qty">${i.minQuantity===1?"1 item":`${i.minQuantity}+ items`}</p>
          </div>
          <span class="pe-vd-label">${i.label||(i.discountType==="percentage"?`-${Math.round(i.discountValue)}%`:"Deal")}</span>
          <div class="pe-vd-price">
            ${i.originalPriceCents!==i.discountedPriceCents?`<p class="pe-vd-price-original">${n(i.originalPriceCents)}</p>`:""}
            <p class="pe-vd-price-discounted">${n(i.discountedPriceCents)} each</p>
          </div>
        </div>`).join("");this.shadowRoot.innerHTML=`
      <style>${en}</style>
      <div class="pe-vd-wrap">
        <div class="pe-vd-title">Volume Discounts</div>
        ${r}
      </div>
    `,this.shadowRoot.querySelectorAll(".pe-vd-tier").forEach(i=>{i.addEventListener("click",()=>{let o=parseInt(i.dataset.qty??"1",10),a=document.querySelector('input[name="quantity"]');a&&(a.value=String(o),a.dispatchEvent(new Event("change",{bubbles:!0}))),this.shadowRoot?.querySelectorAll(".pe-vd-tier").forEach(l=>l.classList.remove("pe-active")),i.classList.add("pe-active")})})}renderEmpty(){this.shadowRoot&&(this.shadowRoot.innerHTML="<style>:host { display: none; }</style>")}};customElements.define("promo-volume-discount",$e);function J(t){let e=document.createElement("div");return e.textContent=String(t??""),e.innerHTML}function tn(t){if(typeof t!="string"||!t)return null;try{let e=new URL(t,window.location.href);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}var yt=`
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
`,qe=class extends HTMLElement{filterOfferIds=[];unsubscribe=null;connectedCallback(){let e=this.getAttribute("offer-ids");this.filterOfferIds=e?e.split(",").map(n=>n.trim()):[],this.attachShadow({mode:"open"}),this.render([]),this.unsubscribe=k(g.EvaluationCompleted,n=>{let r=Array.isArray(n.qualifiedOffers)?n.qualifiedOffers:[];this.filterOfferIds.length>0&&(r=r.filter(i=>this.filterOfferIds.includes(i.offerId))),this.render(r.map(i=>({offerId:i.offerId,title:i.type,description:"",imageUrl:null,badgeText:"Active"})))})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;let n=J(this.getAttribute("title")??"Today's Offers");if(e.length===0){this.shadowRoot.innerHTML=`<style>${yt}</style><div class="pe-tob-empty"></div>`;return}let r=e.map(i=>{let o=J(i.offerId),a=J(i.title),l=J(i.description),u=J(i.badgeText),s=tn(i.imageUrl);return`
      <div class="pe-tob-item" data-offer="${o}" role="button" tabindex="0">
        ${s?`<img class="pe-tob-img" src="${s}" alt="${a}" loading="lazy">`:'<div class="pe-tob-img" aria-hidden="true">\u{1F381}</div>'}
        <div class="pe-tob-info">
          <p class="pe-tob-title">${a}</p>
          ${l?`<p class="pe-tob-desc">${l}</p>`:""}
        </div>
        <span class="pe-tob-badge">${u}</span>
      </div>
    `}).join("");this.shadowRoot.innerHTML=`
      <style>${yt}</style>
      <div class="pe-tob-wrap">
        <div class="pe-tob-header">${n}</div>
        <div class="pe-tob-items">${r}</div>
      </div>
    `,this.shadowRoot.querySelectorAll(".pe-tob-item").forEach(i=>{let o=i.dataset.offer??"";i.addEventListener("click",()=>{E("promo_engine:widget_clicked",{offer_id:o,widget_type:"today_offer_block"})})})}};customElements.define("promo-today-offer-block",qe);return kt(nn);})();
