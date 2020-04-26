// import 'neuroglancer/social_share/jssocials-theme-classic.css';
import 'neuroglancer/social_share/font-awesome-4.7.0/css/font-awesome.css';
import 'neuroglancer/social_share/jssocials.css';
import 'neuroglancer/social_share/jssocials-theme-flat.css';
// import 'neuroglancer/social_share/jssocials-theme-minimal.css';
// import 'neuroglancer/social_share/jssocials-theme-plain.css';

export function createSocialBar(link: string) {
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
    shares: ['email', 'twitter', 'facebook', 'pinterest', 'stumbleupon'],
    url: link,
    text: 'text to share',
    showLabel: false,
    showCount: false,
    shareIn: 'popup'
  });
  return socials;
}
