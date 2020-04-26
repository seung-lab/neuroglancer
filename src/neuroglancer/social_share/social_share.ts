// import 'neuroglancer/social_share/jssocials-theme-classic.css';
import 'neuroglancer/social_share/fontawesome-free-5.13.0-web/css/brands.css';
import 'neuroglancer/social_share/jssocials-theme-flat.css';
// import 'neuroglancer/social_share/jssocials-theme-minimal.css';
// import 'neuroglancer/social_share/jssocials-theme-plain.css';

export function createSocialBar() {
  const jQuery = require('neuroglancer/social_share/jquery.3.5.0');
  (<any>window).jQuery = jQuery;
  (<any>window).$ = (<any>window).jQuery;
  require('neuroglancer/social_share/jssocials');
  const socials = document.createElement('div');
  const jssocials = (<any>window).jsSocials;
  const $ = (<any>window).$;
  if (!$ || !jssocials) {
    return socials;
  }

  const socialBar = $(socials);
  socialBar.jsSocials({
    shares: [
      'email', 'twitter', 'facebook', 'googleplus', 'linkedin', 'pinterest', 'stumbleupon',
      'pocket', 'whatsapp', 'viber', 'messenger', 'vkontakte', 'telegram', 'line'
    ],
    url: 'http://url.to.share',
    text: 'text to share',
    showLabel: false,
    showCount: false,
    shareIn: 'popup'
  });
  return socials;
}
