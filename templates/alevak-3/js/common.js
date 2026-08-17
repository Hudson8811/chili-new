$(function(){
	$('.menubg').click(function() {
		$('.menubg').fadeOut();
		$('.header ul').removeClass('opened');
	});
	$('.burger').click(function() {
		$('.menubg').fadeIn();
		$('.header ul').addClass('opened');
	});
	$('.menubg2').click(function() {
		$('.menubg2').fadeOut();
		$('.site-menu').removeClass('opened');
	});
	$('.header .logo .menu-button').click(function() {
		$('.menubg2').fadeIn();
		$('.site-menu').addClass('opened');
	});
	$('.totop').bind("click", function(e){
	  var anchor = $(this);
	  $('html, body').stop().animate({
		 scrollTop: $(anchor.attr('href')).offset().top
	  }, 1000);
	  e.preventDefault();
	});
	$(window).scroll(function() {
		if($(this).scrollTop() > 280) {
			$('.totop').addClass('opened');
		} else {
			$('.totop').removeClass('opened');
		}
	});
});