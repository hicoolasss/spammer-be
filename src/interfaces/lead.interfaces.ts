export interface LeadData {
  name: string;
  lastname: string;
  phone: string;
  email: string;
}

interface FormField {
  selector: string;
  type: 'name' | 'surname' | 'phone' | 'email' | 'checkbox';
  confidence: number;
}

interface FormAnalysis {
  formIndex: number;
  fields: FormField[];
  confidence: number;
  reason: string;
}

export interface FormAnalysisResult {
  bestForm: FormAnalysis;
  allForms: FormAnalysis[];
}
