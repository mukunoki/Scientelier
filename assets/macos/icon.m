#import <AppKit/AppKit.h>

// Icon generation is a build-time operation, not part of normal app startup.
static int makeIcons(NSString *directory) {
  NSArray *sizes = @[@16, @32, @128, @256, @512];
  for (NSNumber *size in sizes) for (int scale = 1; scale <= 2; scale++) {
    NSInteger logical = size.integerValue, pixels = logical * scale;
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
      pixelsWide:pixels pixelsHigh:pixels bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES
      isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    if (!bitmap) return 1;
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
    NSAffineTransform *transform = [NSAffineTransform transform];
    [transform scaleBy:pixels / 512.0]; [transform concat];
    NSBezierPath *tile = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(32, 32, 448, 448) xRadius:100 yRadius:100];
    NSGradient *gradient = [[NSGradient alloc] initWithStartingColor:[NSColor colorWithSRGBRed:0.65 green:0.51 blue:1 alpha:1]
      endingColor:[NSColor colorWithSRGBRed:0.39 green:0.48 blue:0.96 alpha:1]];
    [gradient drawInBezierPath:tile angle:-45];
    NSDictionary *attributes = @{NSFontAttributeName:[NSFont systemFontOfSize:186 weight:NSFontWeightBold],
      NSForegroundColorAttributeName:[NSColor colorWithSRGBRed:0.05 green:0.05 blue:0.09 alpha:1]};
    NSString *label = @"Sc"; NSSize text = [label sizeWithAttributes:attributes];
    [label drawAtPoint:NSMakePoint((512-text.width)/2, (512-text.height)/2) withAttributes:attributes];
    [NSGraphicsContext restoreGraphicsState];
    NSString *name = [NSString stringWithFormat:@"icon_%ldx%ld%@.png", (long)logical, (long)logical, scale == 2 ? @"@2x" : @""];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (![png writeToFile:[directory stringByAppendingPathComponent:name] atomically:YES]) return 1;
  }
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    return argc == 2 ? makeIcons([NSString stringWithUTF8String:argv[1]]) : 1;
  }
}
