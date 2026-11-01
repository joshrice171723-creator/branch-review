using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;

class InstallerWindow : Window {
  Grid overlay;
  readonly Scene scene = new Scene();
  readonly Button action = new Button();
  readonly TextBlock status = new TextBlock();
  readonly ProgressBar progress = new ProgressBar();
  readonly DispatcherTimer timer = new DispatcherTimer();
  readonly Stopwatch clock = Stopwatch.StartNew();
  bool installing, complete, launchAttempted;
  readonly bool preview;
  double completedAt;

  [STAThread] static int Main(string[] args) {
    if (args.Any(a => a.Equals("/S", StringComparison.OrdinalIgnoreCase))) { try { return Install(args); } catch { return 1; } }
    var app = new Application(); app.Run(new InstallerWindow(args.Contains("--preview-animation"))); return 0;
  }
  static int Install(string[] args) {
    string dir = Path.Combine(Path.GetTempPath(), "branch-review-setup-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(dir);
    try {
      string payload = Path.Combine(dir, "installer.exe");
      using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("installer.exe"))
      using (FileStream target = File.Create(payload)) { if (source == null) throw new IOException("Installer payload is missing."); source.CopyTo(target); }
      string command = String.Join(" ", args.Select(a => a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase) ? a : (a.IndexOf(' ') >= 0 ? "\"" + a.Replace("\"", "\\\"") + "\"" : a)));
      using (Process child = Process.Start(new ProcessStartInfo(payload, command) { UseShellExecute = false, CreateNoWindow = true })) { child.WaitForExit(); return child.ExitCode; }
    } finally { try { Directory.Delete(dir, true); } catch { } }
  }
  InstallerWindow(bool previewAnimation) {
    preview = previewAnimation;
    Title = "Install Branch Review"; Width = 860; Height = 670; MinWidth = 680; MinHeight = 570;
    WindowStartupLocation = WindowStartupLocation.CenterScreen; Background = Brushes.Black;
    var grid = new Grid(); Content = grid; grid.Children.Add(scene);
    overlay = new Grid { Margin = new Thickness(44, 36, 44, 30) }; grid.Children.Add(overlay);
    overlay.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
    overlay.RowDefinitions.Add(new RowDefinition());
    overlay.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
    var brand = new TextBlock { Text = "BRANCH REVIEW", Foreground = Brush("#DCD5FF"), FontFamily = new FontFamily("Segoe UI"), FontSize = 12, FontWeight = FontWeights.SemiBold };
    overlay.Children.Add(brand);
    var bottom = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Width = 360 }; Grid.SetRow(bottom, 2); overlay.Children.Add(bottom);
    var title = new TextBlock { Text = "A clearer way to review.", TextAlignment = TextAlignment.Center, FontFamily = new FontFamily("Georgia"), Foreground = Brushes.White, FontSize = 27, Margin = new Thickness(0, 0, 0, 10) }; bottom.Children.Add(title);
    status.Text = "Your workspace is ready to install."; status.TextAlignment = TextAlignment.Center; status.Foreground = Brush("#C7C0E4"); status.FontSize = 13; status.TextWrapping = TextWrapping.Wrap; status.Margin = new Thickness(0, 0, 0, 20); bottom.Children.Add(status);
    progress.Height = 4; progress.IsIndeterminate = true; progress.Visibility = Visibility.Collapsed; progress.Margin = new Thickness(0, 0, 0, 16); bottom.Children.Add(progress);
    action.Content = "Install Branch Review"; action.Height = 46; action.Background = Brush("#F3EAFF"); action.Foreground = Brush("#28194C"); action.BorderThickness = new Thickness(0); action.FontWeight = FontWeights.SemiBold; action.Cursor = System.Windows.Input.Cursors.Hand; action.Click += BeginInstall; bottom.Children.Add(action);
    if (preview) { action.Content = "Preview opening animation"; status.Text = "Animation preview - nothing will be installed."; }
    timer.Interval = TimeSpan.FromMilliseconds(16); timer.Tick += Tick; timer.Start();
    Closing += (sender, e) => { if (installing && !complete) e.Cancel = true; };
  }
  static SolidColorBrush Brush(string value) { return (SolidColorBrush)new BrushConverter().ConvertFromString(value); }
  static string InstalledApp() {
    using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\11871f03-e2b8-59f7-9569-da2b0e6c3dd8")) {
      string command = key == null ? null : key.GetValue("UninstallString") as string;
      if (!String.IsNullOrEmpty(command) && command[0] == '"') {
        int end = command.IndexOf('"', 1);
        if (end > 1) {
          string uninstaller = command.Substring(1, end - 1);
          if (String.Equals(Path.GetFileName(uninstaller), "Uninstall Branch Review.exe", StringComparison.OrdinalIgnoreCase)) {
            string executable = Path.Combine(Path.GetDirectoryName(uninstaller), "Branch Review.exe");
            if (File.Exists(executable)) return executable;
          }
        }
      }
    }
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Branch Review", "Branch Review.exe");
  }
  async void BeginInstall(object sender, RoutedEventArgs e) {
    installing = true; action.Visibility = Visibility.Collapsed; progress.Visibility = Visibility.Visible; status.Text = preview ? "Previewing the animation…" : "Installing Branch Review…";
    try {
      int code;
      if (preview) { await Task.Delay(1600); code = 0; } else code = await Task.Run(() => Install(new string[] { "/S" }));
      if (code != 0) throw new Exception("The installer returned error " + code + ".");
      complete = true; progress.Visibility = Visibility.Collapsed; completedAt = clock.Elapsed.TotalSeconds; status.Text = preview ? "Opening animation…" : "Installed. Opening Branch Review…";
    } catch (Exception error) {
      installing = false; progress.Visibility = Visibility.Collapsed; status.Text = "Installation didn't finish. " + error.Message; action.Content = "Try again"; action.Visibility = Visibility.Visible;
    }
  }
  void Tick(object sender, EventArgs e) {
    scene.Time = clock.Elapsed.TotalSeconds; scene.Open = complete ? Math.Min(1, (scene.Time - completedAt) / 4.2) : 0; overlay.Opacity = launchAttempted ? 1 : 1 - Math.Min(1, scene.Open * 3); scene.InvalidateVisual();
    if (complete && !launchAttempted && scene.Open >= 1) {
      launchAttempted = true;
      if (preview) { complete = false; installing = false; launchAttempted = false; action.Visibility = Visibility.Visible; status.Text = "Animation preview - nothing was installed."; return; }
      try { Process.Start(InstalledApp()); Close(); }
      catch (Exception error) { installing = false; status.Text = "Installed, but couldn't open the app. " + error.Message; action.Content = "Close"; action.Visibility = Visibility.Visible; action.Click -= BeginInstall; action.Click += (s, a) => Close(); }
    }
  }
}

class Scene : FrameworkElement {
  public double Time, Open;
  double angle, lastTime;
  static SolidColorBrush B(string color) { return (SolidColorBrush)new BrushConverter().ConvertFromString(color); }
  Point P(double x,double y,double z,double s,double cx,double cy) {
    double xr=x*Math.Cos(angle)+z*Math.Sin(angle), zr=-x*Math.Sin(angle)+z*Math.Cos(angle);
    double perspective=5.5/(5.5-zr*.3);
    return new Point(cx+xr*s*perspective,cy+(y+zr*.35)*s*perspective);
  }
  void Poly(DrawingContext dc,Brush fill,Pen pen,params Point[] points) {
    var shape=new StreamGeometry();using(var g=shape.Open()){g.BeginFigure(points[0],true,true);g.PolyLineTo(points.Skip(1).ToArray(),true,false);}shape.Freeze();dc.DrawGeometry(fill,pen,shape);
  }
  void Glow(DrawingContext dc,Point center,double rx,double ry,Color color) {
    var brush=new RadialGradientBrush(color,Colors.Transparent);dc.DrawEllipse(brush,null,center,rx,ry);
  }
  protected override void OnRender(DrawingContext dc) {
    double dt=Math.Min(.05,Time-lastTime);lastTime=Time;
    angle+=dt*.38*(1-Math.Min(1,Open*4));
    double phase=Math.Min(1,Open/.6),ease=phase*phase*(3-2*phase),zoom=Math.Max(0,(Open-.45)/.55),w=ActualWidth,h=ActualHeight,cx=w/2,cy=h*.42+Math.Sin(Time*.9)*4,s=Math.Min(w,h)*.18;
    dc.DrawRectangle(B("#09091D"),null,new Rect(0,0,w,h));
    Glow(dc,new Point(cx,cy-70),w*.6,h*.7,Color.FromArgb(110,66,40,165));
    Glow(dc,new Point(cx,cy+s*1.45),s*2.2,s*.38,Color.FromArgb(110,101,44,191));
    Glow(dc,new Point(cx,cy+s*1.5),s*1.5,s*.2,Color.FromArgb(210,3,2,15));
    for(int i=0;i<36;i++){double x=((i*197)%997)/997.0*w,y=((i*349)%907)/907.0*h;double alpha=.25+.2*Math.Sin(Time*.6+i);dc.PushOpacity(alpha);dc.DrawEllipse(Brushes.White,null,new Point(x,y),i%7==0?1.2:.6,i%7==0?1.2:.6);dc.Pop();}
    Point focal=new Point(cx,cy-s*.45);
    double magnification=1+zoom*zoom*18;
    dc.PushTransform(new ScaleTransform(magnification,magnification,focal.X,focal.Y));
    var vertices=new Point[16];
    double rotation=angle*.65, tilt=.35, expansion=1+ease*.6;
    for(int i=0;i<16;i++) {
      double x=(i&1)==0?-1:1,y=(i&2)==0?-1:1,z=(i&4)==0?-1:1,q=(i&8)==0?-1:1;
      // Rotate in the XW plane, then project four dimensions into three.
      double xr=x*Math.Cos(rotation)-q*Math.Sin(rotation),qr=x*Math.Sin(rotation)+q*Math.Cos(rotation);
      double depth=2.7/(2.7-qr),yr=y*Math.Cos(tilt)-z*Math.Sin(tilt),zr=y*Math.Sin(tilt)+z*Math.Cos(tilt);
      vertices[i]=P(xr*depth*expansion,yr*depth*expansion,zr*depth*expansion,s*.67,cx,cy-s*.45);
    }
    dc.PushOpacity(1-ease*.65);
    for(int i=0;i<16;i++) for(int axis=0;axis<4;axis++) {
      int j=i^(1<<axis);if(j<i)continue;
      Color color=axis==3?Color.FromRgb(145,185,255):Color.FromRgb(210,153,255);
      dc.DrawLine(new Pen(new SolidColorBrush(Color.FromArgb(18,color.R,color.G,color.B)),12),vertices[i],vertices[j]);
      dc.DrawLine(new Pen(new SolidColorBrush(Color.FromArgb(45,color.R,color.G,color.B)),5),vertices[i],vertices[j]);
      dc.DrawLine(new Pen(new SolidColorBrush(color),1.4),vertices[i],vertices[j]);
    }
    foreach(Point vertex in vertices) { Glow(dc,vertex,8,8,Color.FromArgb(150,220,173,255));dc.DrawEllipse(B("#F3DFFF"),null,vertex,1.8,1.8); }
    dc.Pop();
    double pulse=.85+.15*Math.Sin(Time*2.4);
    Glow(dc,focal,s*.65*pulse,s*.65*pulse,Color.FromArgb(120,181,90,255));
    Glow(dc,focal,s*.12,s*.12,Color.FromArgb(220,245,205,255));
    if(ease>0){
      Point core=P(0,-.45,0,s,cx,cy);
      dc.PushOpacity(Math.Min(1,ease*2));
      Poly(dc,new LinearGradientBrush(Color.FromArgb(0,208,164,255),Color.FromArgb(130,238,182,255),90),null,new Point(core.X-s*1.5,core.Y-s*2.8),new Point(core.X+s*1.5,core.Y-s*2.8),new Point(core.X+s*.5,core.Y),new Point(core.X-s*.5,core.Y));
      Glow(dc,core,s*2.4*pulse,s*2.4*pulse,Color.FromArgb(180,164,65,255));
      Glow(dc,core,s*1.1*pulse,s*1.1*pulse,Color.FromArgb(230,237,143,255));
      Glow(dc,core,s*.42,s*.42,Color.FromArgb(255,250,205,255));
      Glow(dc,core,s*.14,s*.14,Colors.White);
      for(int i=0;i<15;i++){double t=(Time*.25+i*.069)%1;Point spark=new Point(core.X+Math.Sin(i*7.1+t)*s*t,core.Y-t*s*2);Glow(dc,spark,5,5,Color.FromArgb((byte)(210*(1-t)),247,214,255));}
      dc.Pop();
    }
    dc.Pop();
    double wash=Math.Max(0,(zoom-.35)/.65);
    dc.DrawRectangle(new SolidColorBrush(Color.FromArgb((byte)(255*wash*wash),251,241,255)),null,new Rect(0,0,w,h));
  }
}
